// input.js — keyboard state for KESTREL POST.
// Tracks held keys as action names plus an edge-triggered `pressed` set
// cleared once per frame via consumeFrame(). Only browser keyboard events;
// game keys preventDefault so the page never scrolls.

// Maps KeyboardEvent.code -> action name.
const KEY_MAP = {
  ArrowLeft: 'bankLeft',
  ArrowRight: 'bankRight',
  ArrowUp: 'pitchUp',
  ArrowDown: 'pitchDown',
  KeyW: 'throttleUp',
  KeyS: 'throttleDown',
  ShiftLeft: 'throttleUp',
  ShiftRight: 'throttleUp',
  ControlLeft: 'throttleDown',
  ControlRight: 'throttleDown',
  Space: 'drop',
  Enter: 'confirm',
  KeyP: 'pause',
  KeyR: 'restart',
  KeyM: 'mute',
};

export function createInput(target = typeof window !== 'undefined' ? window : null) {
  const held = new Set();    // action names currently held
  const pressed = new Set(); // edge-triggered actions since last consumeFrame()

  function onKeyDown(e) {
    const action = KEY_MAP[e.code];
    if (!action) return;
    e.preventDefault();
    // Ignore auto-repeat for edge-triggered keys; held keys track Set anyway.
    if (!e.repeat) {
      pressed.add(action);
      held.add(action);
    }
  }

  function onKeyUp(e) {
    const action = KEY_MAP[e.code];
    if (!action) return;
    e.preventDefault();
    held.delete(action);
  }

  function onBlur() {
    held.clear();
    pressed.clear();
  }

  function attach() {
    if (!target || !target.addEventListener) return;
    target.addEventListener('keydown', onKeyDown);
    target.addEventListener('keyup', onKeyUp);
    target.addEventListener('blur', onBlur);
  }

  function detach() {
    if (!target || !target.removeEventListener) return;
    target.removeEventListener('keydown', onKeyDown);
    target.removeEventListener('keyup', onKeyUp);
    target.removeEventListener('blur', onBlur);
    held.clear();
    pressed.clear();
  }

  // Call once per frame after reading input; clears edge-triggered actions.
  function consumeFrame() {
    pressed.clear();
  }

  return { held, pressed, attach, detach, consumeFrame };
}
