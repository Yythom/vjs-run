export default function Welcome() {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-3 text-slate-500 p-8 select-none">
      <div className="w-14 h-14 rounded-2xl bg-slate-100/80 border border-slate-200/80 flex items-center justify-center text-slate-400 mb-1 shadow-2xs">
        <svg className="w-7 h-7" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="m6.75 7.5 3 2.25-3 2.25m4.5 0h3m-9 8.25h13.5A2.25 2.25 0 0 0 21 18V6a2.25 2.25 0 0 0-2.25-2.25H5.25A2.25 2.25 0 0 0 3 6v12a2.25 2.25 0 0 0 2.25 2.25Z" />
        </svg>
      </div>
      <h2 className="text-sm font-bold text-slate-700">
        暂无活跃的项目终端日志
      </h2>
      <p className="text-xs text-slate-400 text-center max-w-sm leading-relaxed">
        请点击「项目管理」看板中对应项目的「日志」或「启动」按钮开启监控终端
      </p>
    </div>
  );
}
