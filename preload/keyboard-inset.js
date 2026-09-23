/**
 * DSH Web - bind the app shell to the VISUAL viewport, not the layout viewport.
 *
 * Pair of keyboard-inset.css. Publishes:
 *   --dsh-vv-h     visualViewport.height      (height of the visible band)
 *   --dsh-vv-top   visualViewport.offsetTop   (where the band starts)
 *   data-dsh-vv    "keyboard" | "full"
 *
 * Measured on iPhone 15 / iOS 17.1.1, from scroll-probe.js:
 *   composer screen bottom = 659 - vvTop        (659 = layout viewport)
 *   visible  <=>  659 - vvTop <= vvH
 * before this layer existed the composer left the screen by up to 186px on every
 * backspace. After it: rootH == vvH on 79/79 settled keyboard-up samples.
 *
 * IMPORTANT: layoutHeight is documentElement.clientHeight, NOT window.innerHeight.
 * On this device innerHeight tracks the VISUAL viewport (315 with the keyboard up)
 * while the layout viewport that html{height:100%} resolves against stays at 659.
 *
 *
 * It also stops the composer's toolbar buttons from raising the keyboard. The
 * InputBar wires `onMouseDown: keepFocus` on four buttons - commands, attach,
 * stop and send - and keepFocus does preventDefault() and then focuses the
 * Lexical root. On desktop that keeps the caret so you can go on typing; on a
 * phone it means tapping the attach button pops the keyboard up. React listens
 * for mousedown on the root container in the bubble phase, so stopping the event
 * in the capture phase at document level means the handler never runs. The click
 * event is left alone, so every button still does its job, and Safari does not
 * move focus to a button on tap, so an editor that already had the caret keeps
 * it and the keyboard neither opens nor closes.
 *
 * Applied SYNCHRONOUSLY inside the visualViewport events, on purpose. A variant
 * that coalesced to one rAF write and clamped a transiently inconsistent
 * (offsetTop + height) was written and deployed on 09-23 and reverted the same
 * day: it brought no visible improvement, and the small stutter while the
 * keyboard animates is accepted rather than chased. The two known costs of THIS
 * version, so nobody re-derives them:
 *   - it relayouts once per visualViewport event, which is what the stutter is;
 *   - during the keyboard animation iOS reports offsetTop and height from
 *     slightly different instants, so their sum can exceed the layout viewport
 *     for a frame and the shell briefly shows a gap above the conversation.
 * Both are cosmetic and were judged cheaper than the alternative.
 */
(function () {
  'use strict'

  var vv = window.visualViewport
  var root = document.documentElement
  var coarse = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches)

  /**
   * Composer toolbar buttons must not force the keyboard up on a touch device.
   * Only mousedown is intercepted: the click still fires, so the command menu
   * opens and the file picker opens exactly as before.
   */
  function keepKeyboardDown(e) {
    if (!coarse) return
    var t = e.target
    if (!t || typeof t.closest !== 'function') return
    // NEVER intercept inside a menu. The command/@ listbox and the model picker
    // commit their selection on mousedown (onPick / onCrumb), so swallowing that
    // event removes the only path that ever runs and the item looks dead. That was
    // a real regression from the first version of this function.
    if (t.closest('[role="listbox"],[role="menu"],[role="option"],[role="menuitem"],[data-trigger-menu]')) return
    if (!t.closest('button')) return
    if (!t.closest('[class*="composerSeat"]')) return
    e.stopPropagation()
  }

  function apply() {
    try {
      if (!vv) return
      var h = Math.round(vv.height)
      var top = Math.round(vv.offsetTop)
      root.style.setProperty('--dsh-vv-h', h + 'px')
      root.style.setProperty('--dsh-vv-top', top + 'px')
      // innerHeight tracks the layout viewport here; a gap means the keyboard is up
      var shrunk = h < Math.round(document.documentElement.clientHeight) - 1
      root.setAttribute('data-dsh-vv', shrunk ? 'keyboard' : 'full')
    } catch (e) {
      /* a cosmetic layer must never break the app */
    }
  }

  function start() {
    if (!vv) return
    document.addEventListener('mousedown', keepKeyboardDown, true)
    vv.addEventListener('resize', apply)
    vv.addEventListener('scroll', apply)
    window.addEventListener('resize', apply, { passive: true })
    window.addEventListener('orientationchange', apply, { passive: true })
    apply()
  }

  window.__DSH_VISUAL_VIEWPORT__ = { apply: apply, coarse: coarse }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true })
  } else {
    start()
  }
})()
