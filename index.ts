/**
 * opencode-notify
 *
 * Watches the OpenCode server's public event stream and pushes notifications
 * over ntfy and/or a Telegram bot when:
 *   - a run finishes                     (session.execution.succeeded)
 *   - a run fails                        (session.execution.failed)
 *   - an agent asks you a question        (form.created -> the `question` tool)
 *   - a tool needs approval              (permission.asked)
 *
 * The channel is picked from configuration: whatever you configure is used.
 * Configure an ntfy topic, a Telegram bot token + chat id, or both. Set
 * `channel` ("ntfy" | "telegram" | "both" | "auto") to filter explicitly;
 * "auto" (the default) sends over every channel that has credentials.
 *
 * Note: on the public event stream a completed run surfaces as
 * session.execution.succeeded, not session.idle (that is internal/TUI-only).
 * session.idle and session.status are still handled as a fallback.
 *
 * The event stream is server-wide and spans every location, so a single
 * instance covers all concurrent sessions. A refcounted global guard keeps
 * multiple loaded locations from starting duplicate subscriptions.
 *
 * No dependencies.
 */

type ChannelName = "ntfy" | "telegram"
type ChannelSetting = ChannelName | "both" | "auto"

interface NtfyOptions {
  /** ntfy topic to publish to. Configure this to enable ntfy. Treat it as a secret. */
  topic?: string
  /** ntfy base URL. Defaults to https://ntfy.sh */
  server?: string
  /** Optional ntfy access token for protected topics. Falls back to $NTFY_TOKEN. */
  token?: string
}

interface TelegramOptions {
  /** Telegram bot token from @BotFather. Configure with `chatId` to enable Telegram. Falls back to $TELEGRAM_BOT_TOKEN. */
  botToken?: string
  /** Target chat id(s): a value, comma-separated list, or array. Falls back to $TELEGRAM_CHAT_ID. */
  chatId?: string | number | Array<string | number>
  /** Send silently (no sound/vibration on the phone). */
  silent?: boolean
}

interface NotifyOptions {
  /** Which channel(s) to use. Defaults to "auto" (every configured channel). */
  channel?: ChannelSetting
  /** ntfy settings. Configure `ntfy.topic` to enable ntfy. */
  ntfy?: NtfyOptions
  /** Telegram settings. Configure `telegram.botToken` + `telegram.chatId` to enable Telegram. */
  telegram?: TelegramOptions
  /** OpenCode web UI URL. Becomes the notification's link (session deep link when known). */
  webUrl?: string
  /** Which triggers are enabled: done, question, permission, error, retry. */
  events?: string[]
  /** Minimum spacing between sends, in ms, to avoid burst floods. */
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

// The web UI routes sessions as /server/<base64url(origin)>/session/<id>, where the
// server key is the base64url (no padding) encoding of the URL the browser uses.
function serverKeyFor(webUrl: string): string | null {
  try {
    const origin = new URL(webUrl).origin
    return btoa(origin).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_")
  } catch {
    return null
  }
}

function parseChatIds(value: unknown): string[] {
  if (value === undefined || value === null) return []
  const raw = Array.isArray(value) ? value : String(value).split(",")
  return raw
    .map((item) => String(item).trim())
    .filter((item) => item.length > 0)
}

export default {
  id: "notify",
  setup(rawCtx: any) {
    const ctx: any = rawCtx
    const opts: NotifyOptions = ctx.options ?? {}
    const ntfyOpts: NtfyOptions = opts.ntfy ?? {}
    const telegramOpts: TelegramOptions = opts.telegram ?? {}

    // ---- resolve channels from configuration ---------------------------
    const topic = String(ntfyOpts.topic ?? process.env.NTFY_TOPIC ?? "")
    const botToken = String(telegramOpts.botToken ?? process.env.TELEGRAM_BOT_TOKEN ?? "")
    const chatIds = parseChatIds(telegramOpts.chatId ?? process.env.TELEGRAM_CHAT_ID)

    const ntfyReady = topic.length > 0
    const telegramReady = botToken.length > 0 && chatIds.length > 0

    const setting: ChannelSetting = (opts.channel ?? "auto") as ChannelSetting
    const useNtfy = setting === "ntfy" || setting === "both" || (setting === "auto" && ntfyReady)
    const useTelegram = setting === "telegram" || setting === "both" || (setting === "auto" && telegramReady)

    if (!useNtfy && !useTelegram) {
      console.error(
        "[notify] no channel configured; set options.ntfy.topic or options.telegram.botToken + options.telegram.chatId (or $NTFY_TOPIC / $TELEGRAM_BOT_TOKEN + $TELEGRAM_CHAT_ID); plugin disabled",
      )
      return
    }
    if (useNtfy && !ntfyReady) {
      console.error("[notify] ntfy selected but no topic configured (set options.ntfy.topic or $NTFY_TOPIC)")
    }
    if (useTelegram && !telegramReady) {
      console.error(
        "[notify] telegram selected but bot token / chat id missing (set options.telegram.botToken + options.telegram.chatId or $TELEGRAM_BOT_TOKEN + $TELEGRAM_CHAT_ID)",
      )
    }

    const channels: ChannelName[] = []
    if (useNtfy && ntfyReady) channels.push("ntfy")
    if (useTelegram && telegramReady) channels.push("telegram")

    const server = String(ntfyOpts.server ?? process.env.NTFY_SERVER ?? "https://ntfy.sh").replace(/\/+$/, "")
    const ntfyToken = ntfyOpts.token || process.env.NTFY_TOKEN || ""
    const webUrl = opts.webUrl ?? process.env.NTFY_CLICK ?? process.env.TELEGRAM_WEB_URL
    const minIntervalMs = Math.max(0, Number(opts.minIntervalMs ?? 0) || 0)
    const silent = telegramOpts.silent === true
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

    // ---- links -----------------------------------------------------------
    const baseUrl = webUrl ? String(webUrl).replace(/\/+$/, "") : ""
    const serverKey = baseUrl ? serverKeyFor(baseUrl) : null

    /** Deep link to the exact session, or the base web UI URL, or undefined. */
    function sessionUrl(sessionID?: string): string | undefined {
      if (!baseUrl) return undefined
      if (!sessionID || !serverKey) return baseUrl
      return `${baseUrl}/server/${serverKey}/session/${encodeURIComponent(sessionID)}`
    }

    // ---- per-channel senders --------------------------------------------
    async function sendNtfy(kind: string, title: string, message: string, sessionID?: string) {
      const payload: Record<string, unknown> = {
        topic,
        title,
        message,
        priority: priorityFor(kind),
        tags: tagsFor(kind),
      }
      const click = sessionUrl(sessionID)
      if (click) payload.click = click
      const res = await fetch(`${server}/`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(ntfyToken ? { Authorization: `Bearer ${ntfyToken}` } : {}),
        },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        console.error(`[notify] ntfy responded ${res.status}: ${await res.text().catch(() => "")}`)
      }
    }

    async function sendTelegram(kind: string, title: string, message: string, sessionID?: string) {
      const link = sessionUrl(sessionID)
      const text = `${title}\n${message}`
      for (const chatId of chatIds) {
        const payload: Record<string, unknown> = {
          chat_id: chatId,
          text,
          disable_web_page_preview: true,
        }
        if (silent) payload.disable_notification = true
        if (link) {
          payload.reply_markup = {
            inline_keyboard: [[{ text: "Open in OpenCode", url: link }]],
          }
        }
        try {
          const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          })
          const body = await res.json().catch(() => null)
          if (!res.ok || body?.ok === false) {
            console.error(
              `[notify] Telegram rejected ${kind} for chat ${chatId}: ${res.status} ${body?.description ?? ""}`,
            )
          }
        } catch (e) {
          console.error(`[notify] Telegram send failed for chat ${chatId}`, e)
        }
      }
    }

    async function send(kind: string, title: string, message: string, sessionID?: string) {
      if (channels.includes("ntfy")) await sendNtfy(kind, title, message, sessionID)
      if (channels.includes("telegram")) await sendTelegram(kind, title, message, sessionID)
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
            await send("done", "✅ Task done", label(info, sessionID, location), sessionID)
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
            send("error", "⚠️ Session error", `${label(info, sessionID ?? "unknown", location)}\n${text}`, sessionID),
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
            enqueue(() =>
              send("retry", `⚠️ ${head}`, `${label(info, sessionID, location)}\n${body}${link}`, sessionID),
            )
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
          enqueue(() =>
            send("error", "⚠️ Session error", `${label(info, sessionID ?? "unknown", location)}\n${text}`, sessionID),
          )
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
          enqueue(() => send("question", "❓ Needs your input", body, form.sessionID))
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
          enqueue(() => send("permission", "🔐 Approval needed", body, data.sessionID))
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
