/**
 * Speech Agent — client half.
 *
 * The phone button beside the composer opens a compact in-app panel that hosts
 * the MOSS-Live call page (served by this bundle's Host half, which also holds
 * the API key and bridges delegations into the current DSH session). The panel
 * is an iframe, so duplex audio, interruptions and playback acknowledgements
 * stay exactly as MOSS ships them.
 */
window.__ModuleLoader__.load({
  id: 'dsh-moss-live',
  factory(require) {
    const React = require('react')
    const { useCallback, useRef, useState } = React
    const h = React.createElement

    let createPortal = null
    try {
      createPortal = require('react-dom').createPortal
    } catch {
      createPortal = null
    }

    const CSS = `
.dsa-trigger{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;padding:0;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.dsa-trigger:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsa-trigger:disabled{opacity:.4;cursor:default}
.dsa-trigger svg{width:17px;height:17px;display:block}
.dsa-trigger.dsa-busy svg{animation:dsa-pulse 1s ease-in-out infinite}
@keyframes dsa-pulse{0%,100%{opacity:.35}50%{opacity:1}}

.dsa-panel{position:fixed;right:20px;bottom:20px;z-index:2147483000;width:min(360px,calc(100vw - 40px));height:min(460px,calc(100vh - 40px));display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l3,#ddd);border-radius:16px;background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:0 24px 70px rgba(0,0,0,.35);overflow:hidden}
.dsa-head{display:flex;align-items:center;gap:8px;padding:9px 10px 9px 13px;border-bottom:1px solid var(--dsw-alias-border-l2,#eee);flex:none}
.dsa-title{font-size:13px;font-weight:650;color:var(--dsw-alias-label-primary,#111)}
.dsa-sub{font-size:11px;color:var(--dsw-alias-label-tertiary,#999);margin-left:2px}
.dsa-head .spacer{flex:1}
.dsa-icon{width:26px;height:26px;display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary,#666);cursor:pointer;font-size:13px}
.dsa-icon:hover{background:var(--dsw-alias-interactive-bg-hover,#f2f2f2);color:var(--dsw-alias-label-primary,#111)}
.dsa-body{flex:1;min-height:0;background:transparent}
.dsa-body iframe{width:100%;height:100%;border:0;display:block;background:transparent}
.dsa-state{flex:1;display:flex;align-items:center;justify-content:center;padding:24px;text-align:center;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary,#666)}
.dsa-state.error{color:var(--dsw-alias-state-error-primary,#dc2626)}
`

    function CallButton(props) {
      const { sessionId, locked } = props
      const [open, setOpen] = useState(false)
      const [busy, setBusy] = useState(false)
      const [src, setSrc] = useState('')
      const [frameNote, setFrameNote] = useState('')
      const [micProbe, setMicProbe] = useState('')
      const streamRef = useRef(null)
      const frameRef = useRef(null)
      const [error, setError] = useState('')

      const startCall = useCallback(async () => {
        if (!sessionId) return
        setBusy(true)
        setError('')
        setSrc('')
        setOpen(true)
        // Probe: can the harness page itself reach a microphone? The call page
        // runs in an iframe and may be denied by the shell's permissions policy.
        try {
          const stream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
          })
          streamRef.current = stream
          setMicProbe('麦克风已授权')
        } catch (cause) {
          setMicProbe('麦克风：' + (cause && cause.name ? cause.name : '失败'))
        }
        try {
          const response = await fetch(`/speech/call/open?embed=1&session=${encodeURIComponent(sessionId)}`, { method: 'POST' })
          const payload = await response.json().catch(() => ({}))
          if (!response.ok || !payload.url) throw new Error(payload?.error?.message || `启动失败（HTTP ${response.status}）`)
          setSrc(payload.url)
        } catch (cause) {
          setError(String(cause && cause.message ? cause.message : cause))
        } finally {
          setBusy(false)
        }
      }, [sessionId])

      const close = useCallback(() => {
        setOpen(false)
        setSrc('')
        setError('')
        if (streamRef.current) {
          for (const track of streamRef.current.getTracks()) track.stop()
          streamRef.current = null
        }
      }, [])

      const handMicToFrame = useCallback(() => {
        const frame = frameRef.current
        const stream = streamRef.current
        if (!frame || !stream) return
        try {
          frame.contentWindow.__dshMicStream = stream
        } catch (cause) {
          setMicProbe('注入失败：' + (cause && cause.name ? cause.name : 'error'))
        }
      }, [])

      const panel = open
        ? h('div', { className: 'dsa-panel', role: 'dialog', 'aria-label': '语音通话' },
          h('div', { className: 'dsa-head' },
            h('span', { className: 'dsa-title' }, '语音通话'),
            h('span', { className: 'dsa-sub' }, frameNote === 'error' ? '加载失败' : (micProbe || 'MOSS-Live')),
            h('span', { className: 'spacer' }),
            src ? h('button', {
              type: 'button', className: 'dsa-icon', title: '在新窗口打开',
              onClick: () => window.open(src, 'dsh-moss-call'),
            }, '⤢') : null,
            h('button', { type: 'button', className: 'dsa-icon', title: '结束通话', 'aria-label': '结束通话', onClick: close }, '✕')),
          h('div', { className: 'dsa-body' },
            error
              ? h('div', { className: 'dsa-state error' }, error)
              : src
                ? h('iframe', {
                  ref: frameRef,
                  src,
                  title: 'MOSS-Live 语音通话',
                  allow: 'microphone; autoplay; clipboard-write',
                  referrerPolicy: 'no-referrer',
                  onLoad: () => {
                    setFrameNote('loaded')
                    handMicToFrame()
                  },
                  onError: () => setFrameNote('error'),
                })
                : h('div', { className: 'dsa-state' }, busy ? '正在接通…' : '准备中…')))
        : null

      return h(React.Fragment, null,
        h('button', {
          type: 'button',
          className: 'dsa-trigger' + (busy ? ' dsa-busy' : ''),
          title: '语音通话（MOSS-Live 实时双讲）',
          'aria-label': '语音通话',
          disabled: !sessionId || locked || busy,
          onClick: () => void startCall(),
        }, h('svg', { viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' },
          h('path', {
            d: 'M6.6 3.8c.9 0 1.7.6 1.9 1.5l.7 2.5c.2.8 0 1.6-.6 2.1l-1.2 1.1a13.8 13.8 0 0 0 5.6 5.6l1.1-1.2c.5-.6 1.3-.8 2.1-.6l2.5.7c.9.2 1.5 1 1.5 1.9v1.5c0 1.4-1.1 2.5-2.5 2.5C10.6 21.4 2.6 13.4 2.6 5.9c0-1.4 1.1-2.5 2.5-2.5h1.5Z',
            stroke: 'currentColor',
            strokeWidth: '1.7',
            strokeLinejoin: 'round',
          }))),
        panel ? (createPortal ? createPortal(panel, document.body) : panel) : null,
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const style = document.createElement('style')
        style.dataset.dshSpeechAgent = 'true'
        style.textContent = CSS
        document.head.appendChild(style)

        console.info('[dsh-speech-agent] mounted')
        ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
          name: 'conversation.input.left',
          id: 'speech-agent',
          order: 20,
        }, props => h(CallButton, props)))
      },
    }
  },
})
