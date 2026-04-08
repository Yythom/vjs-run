export default function ToastContainer({ toasts = [] }) {
  return (
    <div className="fixed bottom-4 right-4 flex flex-col gap-1.5 z-50">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={[
            "toast-enter",
            "flex items-center gap-1.5 max-w-[280px]",
            "bg-card border rounded-lg px-3.5 py-2",
            "text-[12.5px] text-slate-200",
            "shadow-[0_4px_18px_rgba(0,0,0,0.5)]",
            t.border || "border-border",
          ].join(" ")}
        >
          <span>{t.icon}</span>
          <span>{t.message}</span>
        </div>
      ))}
    </div>
  );
}
