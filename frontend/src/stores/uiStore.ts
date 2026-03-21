import { create } from 'zustand'

interface UIStore {
  sidebarOpen: boolean
  toggleSidebar: () => void

  schemaPanelOpen: boolean
  toggleSchemaPanel: () => void
  setSchemaPanelOpen: (open: boolean) => void

  activeDsTab: number
  switchDsTab: (idx: number) => void

  activeResultTab: 'schema' | 'chart' | 'sql' | 'report'
  setActiveResultTab: (tab: UIStore['activeResultTab']) => void
}

export const useUIStore = create<UIStore>((set) => ({
  sidebarOpen: false,
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),

  schemaPanelOpen: true,
  toggleSchemaPanel: () => set((s) => ({ schemaPanelOpen: !s.schemaPanelOpen })),
  setSchemaPanelOpen: (open) => set({ schemaPanelOpen: open }),

  activeDsTab: 0,
  switchDsTab: (idx) => set({ activeDsTab: idx }),

  activeResultTab: 'chart',
  setActiveResultTab: (tab) => set({ activeResultTab: tab }),
}))