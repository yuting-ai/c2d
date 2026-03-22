import { create } from 'zustand'

export interface TraceStep {
  agent: string
  label: string
  status: 'done' | 'active' | 'waiting'
}

export interface Exchange {
  id: number
  query: string
  trace: TraceStep[] | null
  reply: string | null
  sqlSteps: { title: string; sql: string; tag: string }[]
  status: 'pending' | 'streaming' | 'done' | 'error'
  error: string | null
}

interface ChatStore {
  exchanges: Exchange[]
  expandedExchangeId: number | null

  addExchange: (query: string) => number
  updateTrace: (id: number, steps: TraceStep[]) => void
  addSqlSteps: (id: number, steps: any[]) => void
  setReply: (id: number, reply: string) => void
  setStatus: (id: number, status: Exchange['status']) => void
  setError: (id: number, error: string) => void
  toggleExchange: (id: number) => void
  expandExchange: (id: number) => void
}

let nextId = 1

export const useChatStore = create<ChatStore>((set) => ({
  exchanges: [],
  expandedExchangeId: null,

  addExchange: (query) => {
    const id = nextId++
    set((s) => ({
      exchanges: [...s.exchanges, {
        id,
        query,
        trace: null,
        reply: null,
        sqlSteps: [],
        status: 'pending',
        error: null,
      }],
      expandedExchangeId: id,
    }))
    return id
  },

  updateTrace: (id, steps) =>
    set((s) => ({
      exchanges: s.exchanges.map((e) =>
        e.id === id ? { ...e, trace: steps, status: 'streaming' } : e
      ),
    })),

  addSqlSteps: (id, steps) =>
    set((s) => ({
      exchanges: s.exchanges.map((e) =>
        e.id === id ? { ...e, sqlSteps: steps } : e
      ),
    })),

  setReply: (id, reply) =>
    set((s) => ({
      exchanges: s.exchanges.map((e) =>
        e.id === id ? { ...e, reply } : e
      ),
    })),

  setStatus: (id, status) =>
    set((s) => ({
      exchanges: s.exchanges.map((e) =>
        e.id === id ? { ...e, status } : e
      ),
    })),

  setError: (id, error) =>
    set((s) => ({
      exchanges: s.exchanges.map((e) =>
        e.id === id ? { ...e, error, status: 'error' } : e
      ),
    })),

  toggleExchange: (id) =>
    set((s) => ({
      expandedExchangeId: s.expandedExchangeId === id ? null : id,
    })),

  expandExchange: (id) => set({ expandedExchangeId: id }),
}))