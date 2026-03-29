import { create } from 'zustand'

interface UIStore {
  sidebarOpen: boolean
  toggleSidebar: () => void

  chatDrawerOpen: boolean
  toggleChatDrawer: () => void
  setChatDrawerOpen: (open: boolean) => void

  schemaPanelOpen: boolean
  toggleSchemaPanel: () => void
  setSchemaPanelOpen: (open: boolean) => void
}

export const useUIStore = create<UIStore>((set) => ({
  sidebarOpen: false,
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),

  chatDrawerOpen: true,
  toggleChatDrawer: () => set((s) => ({ chatDrawerOpen: !s.chatDrawerOpen })),
  setChatDrawerOpen: (open) => set((s) => (s.chatDrawerOpen === open ? s : { chatDrawerOpen: open })),

  schemaPanelOpen: true,
  toggleSchemaPanel: () => set((s) => ({ schemaPanelOpen: !s.schemaPanelOpen })),
  setSchemaPanelOpen: (open) => set((s) => (s.schemaPanelOpen === open ? s : { schemaPanelOpen: open })),
}))