import { create } from 'zustand'

export interface Project {
  id: string
  title: string
  datasetNames: string[]
  createdAt: string
  starred: boolean
  time: string
  editable?: boolean       // title being edited
}

interface ProjectStore {
  projects: Project[]
  activeProjectId: string | null

  selectProject: (id: string | null) => void
  toggleStar: (id: string) => void
  createProject: (title: string, datasetName: string) => string
  updateProjectTitle: (id: string, title: string) => void
  addDatasetToProject: (projectId: string, datasetName: string) => void
  upsertProject: (project: Project) => void
}

function generateId(): string {
  return 'proj_' + Math.random().toString(36).slice(2, 10)
}

function formatTime(): string {
  const now = new Date()
  return now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0')
}

// Derive a project title from filename: "Video Games Sales.csv" → "Video Games Sales"
function titleFromFilename(filename: string): string {
  return filename
    .replace(/\.[^.]+$/, '')           // remove extension
    .replace(/[_-]/g, ' ')            // underscores/hyphens → spaces
    .replace(/\b\w/g, c => c.toUpperCase())  // capitalize words
    .trim()
}

export const useProjectStore = create<ProjectStore>((set, get) => ({
  projects: [],
  activeProjectId: null,

  selectProject: (id) => set({ activeProjectId: id }),

  toggleStar: (id) =>
    set((s) => ({
      projects: s.projects.map((p) =>
        p.id === id ? { ...p, starred: !p.starred } : p
      ),
    })),

  createProject: (title, datasetName) => {
    const id = generateId()
    const project: Project = {
      id,
      title: title || titleFromFilename(datasetName),
      datasetNames: [datasetName],
      createdAt: 'Today',
      starred: false,
      time: formatTime(),
    }
    set((s) => ({
      projects: [project, ...s.projects],
      activeProjectId: id,
    }))
    return id
  },

  updateProjectTitle: (id, title) =>
    set((s) => ({
      projects: s.projects.map((p) =>
        p.id === id ? { ...p, title } : p
      ),
    })),

  addDatasetToProject: (projectId, datasetName) =>
    set((s) => ({
      projects: s.projects.map((p) =>
        p.id === projectId && !p.datasetNames.includes(datasetName)
          ? { ...p, datasetNames: [...p.datasetNames, datasetName] }
          : p
      ),
    })),

  upsertProject: (project) =>
    set((s) => {
      const idx = s.projects.findIndex((p) => p.id === project.id)
      if (idx === -1) {
        return { projects: [project, ...s.projects] }
      }
      const updated = [...s.projects]
      updated[idx] = { ...updated[idx], ...project }
      return { projects: updated }
    }),
}))