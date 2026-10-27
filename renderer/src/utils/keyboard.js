/**
 * 「按回车提交」的判断：排除中文输入法组字时按回车上屏。
 * Chromium 里这次 keydown 的 key 也是 "Enter"，只能靠 isComposing
 * （以及 Safari 系的 keyCode 229）区分，否则拼音打英文按回车会直接提交半截内容。
 */
export function isEnterKey(e) {
  const native = e.nativeEvent ?? e;
  return e.key === "Enter" && !native.isComposing && e.keyCode !== 229;
}
