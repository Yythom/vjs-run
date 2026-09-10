import { useCallback, useLayoutEffect, useRef } from "react";

/**
 * 把一个每次渲染都会重建的回调包成引用恒定的版本。
 *
 * 用途是让 React.memo 的子组件真的挡得住重渲染：父组件里写成内联箭头函数或者
 * 依赖了一堆 state 的 handler，每渲染一次就是一个新引用，memo 的浅比较必然失败。
 * 这里把最新的实现存在 ref 里，对外暴露的函数引用永远不变。
 *
 * 注意返回的函数不能在渲染期间直接调用（ref 还没指向本次渲染的实现），
 * 只能挂在事件回调或 effect 里——它就是给这两种场景用的。
 */
export default function useEventCallback(fn) {
  const ref = useRef(fn);
  useLayoutEffect(() => {
    ref.current = fn;
  });
  return useCallback((...args) => ref.current?.(...args), []);
}
