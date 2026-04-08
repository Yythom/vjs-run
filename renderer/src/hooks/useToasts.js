import { useCallback, useEffect, useRef, useState } from "react";

const TOAST_ICONS = {
  success: "✅",
  error: "❌",
  info: "💜",
  warning: "⚠️",
};

const TOAST_BORDERS = {
  success: "border-green-400/40",
  error: "border-red-400/40",
  info: "border-violet-400/40",
  warning: "border-amber-400/40",
};

export default function useToasts() {
  const [toasts, setToasts] = useState([]);
  const timersRef = useRef(new Map());

  const removeToast = useCallback((id) => {
    const timer = timersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const showToast = useCallback((message, type = "info", duration = 3000) => {
    const id = `${Date.now()}-${Math.random()}`;
    const toast = {
      id,
      message,
      icon: TOAST_ICONS[type] || "",
      border: TOAST_BORDERS[type] || "border-border",
    };

    setToasts((prev) => [...prev, toast]);

    const timer = setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
      timersRef.current.delete(id);
    }, Math.max(0, Number(duration) || 0));

    timersRef.current.set(id, timer);
    return id;
  }, []);

  const clearToasts = useCallback(() => {
    timersRef.current.forEach((timer) => clearTimeout(timer));
    timersRef.current.clear();
    setToasts([]);
  }, []);

  useEffect(() => {
    return () => {
      timersRef.current.forEach((timer) => clearTimeout(timer));
      timersRef.current.clear();
    };
  }, []);

  return {
    toasts,
    showToast,
    removeToast,
    clearToasts,
  };
}
