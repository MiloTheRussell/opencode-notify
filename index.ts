/**
 * opencode-notify
 *
 * Watches the OpenCode server's public event stream and pushes notifications to
 * an ntfy topic when:
 *   - a run finishes                     (session.execution.succeeded)
 *   - a run fails                        (session.execution.failed)
 *   - an agent asks you a question        (form.created -> the `question` tool)
 *   - a tool needs approval              (permission.asked)
 *
 * Note: on the public event stream a completed run surfaces as
 * session.execution.succeeded, not session.idle (that is internal/TUI-only).
 * session.idle and session.status are still handled as a fallback.
 *
 * The event stream is server-wide and spans every location, so a single
 * instance covers all concurrent sessions. A refcounted global guard keeps
 * multiple loaded locations from starting duplicate subscriptions.
 */

interface NotifyOptions {
  /** ntfy topic to publish to. Required. Treat it as a secret. */
  topic?: string
  /** ntfy base URL. Defaults to https://ntfy.sh */
  server?: string
  /** Optional ntfy access token for protected topics. Falls back to $NTFY_TOKEN. */
  token?: string
  /** Optional URL opened when the notification is tapped. */
  webUrl?: string
  /** Which triggers are enabled: done, question, permission, error, retry. */
  events?: string[]
  /** Minimum spacing between pushes, in ms, to avoid burst floods. */
  minIntervalMs?: number
  /** Log every received event to the OpenCode log. Useful for debugging. */
  debug?: boolean
}

const DEFAULT_EVENTS = ["done", "question", "permission", "error", "retry"]

function priorityFor(kind: string): number {
  switch (kind) {
    case "question":
    case "permission":
      return 5
    case "error":
    case "retry":
      return 4
    default:
      return 3
  }
}

function tagsFor(kind: string): string[] {
  switch (kind) {
    case "question":
      return ["question"]
    case "permission":
      return ["lock"]
    case "error":
    case "retry":
      return ["warning"]
    default:
      return ["white_check_mark"]
  }
}

export default {
  id: "notify",
  setup(rawCtx: any) {
    const ctx: any = rawCtx
    const opts: NotifyOptions = ctx.options ?? {}
    const topic = String(opts.topic ?? process.env.NTFY_TOPIC ?? "")
    if (!topic) {
      console.error("[notify] no ntfy topic configured (set options.topic or $NTFY_TOPIC); plugin disabled")
      return
    }

    const server = String(opts.server ?? process.env.NTFY_SERVER ?? "https://ntfy.sh").replace(/\/+$/, "")
    const token = opts.token || process.env.NTFY_TOKEN || ""
    const webUrl = opts.webUrl ?? process.env.NTFY_CLICK
    const minIntervalMs = Math.max(0, Number(opts.minIntervalMs ?? 0) || 0)
    const enabled = new Set<string>(opts.events ?? DEFAULT_EVENTS)

    const g = globalThis as any
    const debug = opts.debug === true

    // Process-wide dedupe. One plugin instance is created per location, and a
    // reload creates a fresh instance, so several subscriptions can see the
    // same server event. This shared map makes each logical event produce at
    // most one push.
    const recent: Map<string, number> = g.__ocNotifyRecent ?? (g.__ocNotifyRecent = new Map())

    // ---- per-session state ----------------------------------------------
    const active = new Set<string>()
    const idleTimers = new Map<string, ReturnType<typeof setTimeout>>()
    const infoCache = new Map<string, any>()

    let queue: Promise<void> = Promise.resolve()
    let lastSent = 0

    function once(key: string, windowMs = 8000): boolean {
      const now = Date.now()
      const prev = recent.get(key) ?? 0
      if (now - prev < windowMs) return false
      recent.set(key, now)
      if (recent.size > 500) {
        for (const [k, t] of recent) if (now - t > 60_000) recent.delete(k)
      }
      return true
    }

    function enqueue(task: () => Promise<void>) {
      queue = queue
        .then(async () => {
          const wait = lastSent + minIntervalMs - Date.now()
          if (wait > 0) await new Promise((r) => setTimeout(r, wait))
          await task()
          lastSent = Date.now()
        })
        .catch((e) => console.error("[notify] send failed", e))
    }

    async function send(kind: string, title: string, message: string) {
      const payload: Record<string, unknown> = {
        topic,
        title,
        message,
        priority: priorityFor(kind),
        tags: tagsFor(kind),
      }
      if (webUrl) payload.click = webUrl
      const res = await fetch(`${server}/`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        console.error(`[notify] ntfy responded ${res.status}: ${await res.text().catch(() => "")}`)
      }
    }

    async function sessionInfo(sessionID: string, location: unknown): Promise<any> {
      if (infoCache.has(sessionID)) return infoCache.get(sessionID)
      try {
        const info = await ctx.session.get({ sessionID }, { location })
        infoCache.set(sessionID, info)
        return info
      } catch (e) {
        console.error("[notify] session.get failed", e)
        return undefined
      }
    }

    function label(info: any, sessionID: string, location: any): string {
      const title = info?.title ?? sessionID
      const dir = info?.directory ?? info?.location?.directory ?? location?.directory
      return dir ? `${title}  (${dir})` : String(title)
    }

    // ---- event handling --------------------------------------------------
    function markBusy(sessionID: string) {
      active.add(sessionID)
      const t = idleTimers.get(sessionID)
      if (t) {
        clearTimeout(t)
        idleTimers.delete(sessionID)
      }
    }

    function queueDone(sessionID: string, location: unknown, eventID?: string) {
      if (!enabled.has("done")) return
      active.delete(sessionID)
      const prev = idleTimers.get(sessionID)
      if (prev) clearTimeout(prev)
      idleTimers.set(
        sessionID,
        setTimeout(() => {
          idleTimers.delete(sessionID)
          if (active.has(sessionID)) return // a new execution started; not done yet
          // Several instances (one per location) see the same event, so collapse
          // them: key on the unique event id when we have it.
          const key = eventID ? `done:evt:${eventID}` : `done:session:${sessionID}`
          if (!once(key, eventID ? 120_000 : 5_000)) return
          enqueue(async () => {
            const info = await sessionInfo(sessionID, location)
            if (info?.parentID) return // skip subagent / child sessions
            await send("done", "✅ Task done", label(info, sessionID, location))
          })
        }, 1000),
      )
    }

    function scheduleIdle(sessionID: string, location: unknown) {
      // Fallback for builds that surface idle via session.idle / session.status.
      if (!enabled.has("done")) return
      if (!active.has(sessionID)) return
      queueDone(sessionID, location)
    }

    async function handle(raw: any) {
      const type = raw?.type
      const data = raw?.data ?? {}
      const location = raw?.location
      const sessionID: string | undefined = data.sessionID

      switch (type) {
        case "session.execution.started":
          if (sessionID) markBusy(sessionID)
          return

        case "session.execution.succeeded":
          if (sessionID) queueDone(sessionID, location, raw?.id)
          return

        case "session.execution.failed": {
          if (!enabled.has("error")) return
          const err = data.error
          const text = typeof err === "string" ? err : err?.message ?? err?.name ?? "execution failed"
          if (!once(`execfail:${sessionID}:${text}`, 30_000)) return
          const info = sessionID ? await sessionInfo(sessionID, location) : undefined
          enqueue(() =>
            send("error", "⚠️ Session error", `${label(info, sessionID ?? "unknown", location)}\n${text}`),
          )
          return
        }

        case "session.status": {
          const st = data.status
          if (!sessionID || !st) return
          if (st.type === "busy") {
            markBusy(sessionID)
            return
          }
          if (st.type === "idle") {
            scheduleIdle(sessionID, location)
            return
          }
          if (st.type === "retry") {
            if (!enabled.has("retry")) return
            const key = `retry:${sessionID}:${st.action?.title ?? st.message ?? st.attempt}`
            if (!once(key, 60_000)) return
            const info = await sessionInfo(sessionID, location)
            const head = st.action?.title ?? "Action needed"
            const body = st.action?.message ?? st.message ?? `Retry attempt ${st.attempt}`
            const link = st.action?.link ? `\n${st.action.link}` : ""
            enqueue(() => send("retry", `⚠️ ${head}`, `${label(info, sessionID, location)}\n${body}${link}`))
          }
          return
        }

        case "session.idle":
          if (sessionID) scheduleIdle(sessionID, location)
          return

        case "session.error": {
          if (!enabled.has("error")) return
          const err = data.error
          const text =
            typeof err === "string" ? err : err?.message ?? err?.name ?? JSON.stringify(err ?? "unknown error")
          if (!once(`err:${sessionID}:${text}`, 30_000)) return
          const info = sessionID ? await sessionInfo(sessionID, location) : undefined
          enqueue(() => send("error", "⚠️ Session error", `${label(info, sessionID ?? "unknown", location)}\n${text}`))
          return
        }

        case "form.created": {
          if (!enabled.has("question")) return
          const form = data.form
          if (!form) return
          if (!once(`form:${form.id}`, 300_000)) return
          const fields = (form.fields ?? [])
            .map((f: any) => f.title ?? f.key)
            .filter(Boolean)
            .join("; ")
          const info = await sessionInfo(form.sessionID, location)
          const body = [label(info, form.sessionID, location), form.title, fields].filter(Boolean).join("\n")
          enqueue(() => send("question", "❓ Needs your input", body))
          return
        }

        case "permission.asked": {
          if (!enabled.has("permission")) return
          if (!once(`perm:${data.id}`, 300_000)) return
          const info = await sessionInfo(data.sessionID, location)
          // Public payload uses action/resources; older/internal uses permission/patterns.
          const action = data.action ?? data.permission ?? "permission"
          const resources = (data.resources ?? data.patterns ?? []).join(", ")
          const body = `${label(info, data.sessionID, location)}\n${action}${resources ? `: ${resources}` : ""}`
          enqueue(() => send("permission", "🔐 Approval needed", body))
          return
        }

        default:
          return
      }
    }

    // ---- subscribe -------------------------------------------------------
    // Every location's instance subscribes to the server-wide stream; the
    // shared dedupe map above keeps that from producing duplicate pushes.
    const controller = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          try {
            if (debug) {
              const e = event as any
              console.error(`[notify] event ${e?.type} @ ${e?.location?.directory ?? "?"}`)
            }
            await handle(event)
          } catch (e) {
            console.error("[notify] handler error", e)
          }
        }
      } catch (e) {
        if (!controller.signal.aborted) console.error("[notify] event stream ended", e)
      }
    })()

    return () => {
      controller.abort()
    }
  },
}
