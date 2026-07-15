export default function TitleBar() {
  return (
    <div className="drag-region h-10 shrink-0 bg-panel border-b border-border flex items-center pl-20 pr-4 gap-2.5 select-none">
      <h1 className="flex items-center gap-2 text-xs font-bold text-slate-600 tracking-wider">
        <img
          src="./logo.svg"
          alt=""
          className="h-5 w-5 rounded-[5px] shadow-sm"
          draggable="false"
        />
        <span>vjtools</span>
      </h1>
    </div>
  );
}
