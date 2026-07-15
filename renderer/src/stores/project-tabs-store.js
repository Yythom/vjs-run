import { create } from "zustand";
import { persist } from "zustand/middleware";

export const useProjectTabsStore = create(
  persist(
    (set, get) => ({
      openedIds: [],
      activeId: null,
      addTab: (id) => {
        const current = get().openedIds;
        if (!current.includes(id)) {
          set({ openedIds: [...current, id] });
        }
        set({ activeId: id });
      },
      removeTab: (id) => {
        const currentIds = get().openedIds.filter((x) => x !== id);
        let nextActive = get().activeId;

        if (id === get().activeId) {
          if (currentIds.length > 0) {
            const index = get().openedIds.indexOf(id);
            const nextIndex = Math.max(0, index - 1);
            nextActive = currentIds[nextIndex];
          } else {
            nextActive = null;
          }
        }

        set({
          openedIds: currentIds,
          activeId: nextActive,
        });
      },
      setActiveId: (id) => set({ activeId: id }),
      clearTabs: () => set({ openedIds: [], activeId: null }),
    }),
    {
      name: "project-tabs-store",
    }
  )
);
