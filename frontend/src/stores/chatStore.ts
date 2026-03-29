import { create } from 'zustand'
import type { NullHandlingWarning, NullHandlingConfig } from '../components/chat/NullHandlingCard'

export type { NullHandlingWarning, NullHandlingConfig }

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
  status: 'pending' | 'streaming' | 'done' | 'error' | 'awaiting_null_handling'
  error: string | null
  // NULL handling fields — set while status === 'awaiting_null_handling'
  nullHandlingWarnings?: NullHandlingWarning[]
  nullHandlingNote?: string | null
}

export interface ChatSession {
  id: string
  title: string
  createdAt: string
  messageCount: number
  exchanges: Exchange[]
}

interface ChatStore {
  sessionsByProject: Record<string, ChatSession[]>
  activeSessionIdByProject: Record<string, string | null>

  initProjectSession: (projectId: string) => void
  getSessionsForProject: (projectId: string | null) => ChatSession[]
  getActiveSessionId: (projectId: string | null) => string | null
  getActiveExchanges: (projectId: string | null) => Exchange[]
  createSession: (projectId: string) => string
  selectSession: (projectId: string, sessionId: string) => void

  addExchange: (projectId: string, query: string) => { exchangeId: number; sessionId: string }
  updateTrace: (projectId: string, sessionId: string, id: number, steps: TraceStep[]) => void
  addSqlSteps: (projectId: string, sessionId: string, id: number, steps: any[]) => void
  setReply: (projectId: string, sessionId: string, id: number, reply: string) => void
  setStatus: (projectId: string, sessionId: string, id: number, status: Exchange['status']) => void
  setError: (projectId: string, sessionId: string, id: number, error: string) => void
  setNullHandlingPending: (
    projectId: string,
    sessionId: string,
    id: number,
    warnings: NullHandlingWarning[]
  ) => void
  setNullHandlingNote: (
    projectId: string,
    sessionId: string,
    id: number,
    note: string | null
  ) => void
}

let nextId = 1
let nextSessionId = 1

const EMPTY_EXCHANGES: Exchange[] = []
const EMPTY_SESSIONS: ChatSession[] = []

function nowTime(): string {
  const d = new Date()
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
}

function truncateTitle(text: string, max = 34): string {
  const t = text.trim()
  if (!t) return 'Untitled session'
  return t.length <= max ? t : `${t.slice(0, max - 1)}...`
}

function createEmptySession(): ChatSession {
  return {
    id: `sess_${nextSessionId++}`,
    title: 'Untitled session',
    createdAt: nowTime(),
    messageCount: 0,
    exchanges: [],
  }
}

function ensureProject(state: ChatStore, projectId: string): { sessions: ChatSession[]; activeSessionId: string } {
  const sessions = state.sessionsByProject[projectId] || EMPTY_SESSIONS
  let activeSessionId = state.activeSessionIdByProject[projectId] || null

  if (sessions.length === 0) {
    const s = createEmptySession()
    return { sessions: [s], activeSessionId: s.id }
  }

  if (!activeSessionId || !sessions.some((s) => s.id === activeSessionId)) {
    activeSessionId = sessions[0].id
  }

  return { sessions, activeSessionId }
}

export const useChatStore = create<ChatStore>((set, get) => ({
  sessionsByProject: {},
  activeSessionIdByProject: {},

  initProjectSession: (projectId) =>
    set((s) => {
      const existing = s.sessionsByProject[projectId]
      if (existing && existing.length > 0) {
        if (s.activeSessionIdByProject[projectId]) return {}
        return {
          activeSessionIdByProject: {
            ...s.activeSessionIdByProject,
            [projectId]: existing[0].id,
          },
        }
      }
      const session = createEmptySession()
      return {
        sessionsByProject: {
          ...s.sessionsByProject,
          [projectId]: [session],
        },
        activeSessionIdByProject: {
          ...s.activeSessionIdByProject,
          [projectId]: session.id,
        },
      }
    }),

  getSessionsForProject: (projectId) => {
    if (!projectId) return EMPTY_SESSIONS
    return get().sessionsByProject[projectId] || EMPTY_SESSIONS
  },

  getActiveSessionId: (projectId) => {
    if (!projectId) return null
    return get().activeSessionIdByProject[projectId] || null
  },

  getActiveExchanges: (projectId) => {
    if (!projectId) return EMPTY_EXCHANGES
    const state = get()
    const sessions = state.sessionsByProject[projectId] || EMPTY_SESSIONS
    const active = state.activeSessionIdByProject[projectId]
    const session = sessions.find((sessionItem) => sessionItem.id === active) || sessions[0]
    return session?.exchanges || EMPTY_EXCHANGES
  },

  createSession: (projectId) => {
    const s = createEmptySession()
    set((state) => ({
      sessionsByProject: {
        ...state.sessionsByProject,
        [projectId]: [s, ...(state.sessionsByProject[projectId] || EMPTY_SESSIONS)],
      },
      activeSessionIdByProject: {
        ...state.activeSessionIdByProject,
        [projectId]: s.id,
      },
    }))
    return s.id
  },

  selectSession: (projectId, sessionId) =>
    set((s) => ({
      activeSessionIdByProject: {
        ...s.activeSessionIdByProject,
        [projectId]: sessionId,
      },
    })),

  addExchange: (projectId, query) => {
    const id = nextId++
    const current = get()
    const ensured = ensureProject(current, projectId)
    const sessionId = ensured.activeSessionId

    set((s) => {
      const sessions = (ensured.sessions || EMPTY_SESSIONS).map((sess) => {
        if (sess.id !== sessionId) return sess
        const exchanges = [...sess.exchanges, {
          id,
          query,
          trace: null,
          reply: null,
          sqlSteps: [],
          status: 'pending' as const,
          error: null,
        }]
        const shouldName = sess.title === 'Untitled session' && sess.messageCount === 0
        return {
          ...sess,
          title: shouldName ? truncateTitle(query) : sess.title,
          messageCount: sess.messageCount + 1,
          exchanges,
        }
      })

      return {
        sessionsByProject: {
          ...s.sessionsByProject,
          [projectId]: sessions,
        },
        activeSessionIdByProject: {
          ...s.activeSessionIdByProject,
          [projectId]: sessionId,
        },
      }
    })

    return { exchangeId: id, sessionId }
  },

  updateTrace: (projectId, sessionId, id, steps) =>
    set((s) => ({
      sessionsByProject: {
        ...s.sessionsByProject,
        [projectId]: (s.sessionsByProject[projectId] || EMPTY_SESSIONS).map((sess) =>
          sess.id !== sessionId
            ? sess
            : {
                ...sess,
                exchanges: sess.exchanges.map((e) =>
                  e.id === id ? { ...e, trace: steps, status: 'streaming' } : e
                ),
              }
        ),
      },
    })),

  addSqlSteps: (projectId, sessionId, id, steps) =>
    set((s) => ({
      sessionsByProject: {
        ...s.sessionsByProject,
        [projectId]: (s.sessionsByProject[projectId] || EMPTY_SESSIONS).map((sess) =>
          sess.id !== sessionId
            ? sess
            : {
                ...sess,
                exchanges: sess.exchanges.map((e) =>
                  e.id === id ? { ...e, sqlSteps: steps } : e
                ),
              }
        ),
      },
    })),

  setReply: (projectId, sessionId, id, reply) =>
    set((s) => ({
      sessionsByProject: {
        ...s.sessionsByProject,
        [projectId]: (s.sessionsByProject[projectId] || EMPTY_SESSIONS).map((sess) =>
          sess.id !== sessionId
            ? sess
            : {
                ...sess,
                exchanges: sess.exchanges.map((e) =>
                  e.id === id ? { ...e, reply } : e
                ),
              }
        ),
      },
    })),

  setStatus: (projectId, sessionId, id, status) =>
    set((s) => ({
      sessionsByProject: {
        ...s.sessionsByProject,
        [projectId]: (s.sessionsByProject[projectId] || EMPTY_SESSIONS).map((sess) =>
          sess.id !== sessionId
            ? sess
            : {
                ...sess,
                exchanges: sess.exchanges.map((e) =>
                  e.id === id ? { ...e, status } : e
                ),
              }
        ),
      },
    })),

  setError: (projectId, sessionId, id, error) =>
    set((s) => ({
      sessionsByProject: {
        ...s.sessionsByProject,
        [projectId]: (s.sessionsByProject[projectId] || EMPTY_SESSIONS).map((sess) =>
          sess.id !== sessionId
            ? sess
            : {
                ...sess,
                exchanges: sess.exchanges.map((e) =>
                  e.id === id ? { ...e, error, status: 'error' } : e
                ),
              }
        ),
      },
    })),

  setNullHandlingPending: (projectId, sessionId, id, warnings) =>
    set((s) => ({
      sessionsByProject: {
        ...s.sessionsByProject,
        [projectId]: (s.sessionsByProject[projectId] || EMPTY_SESSIONS).map((sess) =>
          sess.id !== sessionId
            ? sess
            : {
                ...sess,
                exchanges: sess.exchanges.map((e) =>
                  e.id === id
                    ? { ...e, status: 'awaiting_null_handling', nullHandlingWarnings: warnings }
                    : e
                ),
              }
        ),
      },
    })),

  setNullHandlingNote: (projectId, sessionId, id, note) =>
    set((s) => ({
      sessionsByProject: {
        ...s.sessionsByProject,
        [projectId]: (s.sessionsByProject[projectId] || EMPTY_SESSIONS).map((sess) =>
          sess.id !== sessionId
            ? sess
            : {
                ...sess,
                exchanges: sess.exchanges.map((e) =>
                  e.id === id ? { ...e, nullHandlingNote: note } : e
                ),
              }
        ),
      },
    })),
}))