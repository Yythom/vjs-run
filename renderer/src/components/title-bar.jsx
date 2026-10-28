export default function TitleBar() {
  return (
    <div className="drag-region h-10 shrink-0 bg-panel border-b border-border flex items-center justify-between pl-20 pr-3.5 select-none">
      {/* 左侧 Logo 与应用名 */}
      <div className="flex items-center gap-2">
        <img
          src="./logo.svg"
          alt=""
          className="h-4.5 w-4.5 rounded-[5px] shadow-xs"
          draggable="false"
        />
        <span className="text-xs font-bold text-slate-800 tracking-wide">
          vjtools
        </span>
      </div>
    </div>
  );
}
