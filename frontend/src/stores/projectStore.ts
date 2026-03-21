import { create } from 'zustand'

export interface Project {
  id: string
  title: string
  datasetNames: string[]
  createdAt: string
  starred: boolean
  time: string
}

interface ProjectStore {
  projects: Project[]
  activeProjectId: string | null
  selectProject: (id: string) => void
  toggleStar: (id: string) => void
}

// Mock data matching the prototype
const MOCK_PROJECTS: Project[] = [
  { id: 'p1', title: '华东区渠道对比分析', datasetNames: ['sales_2024.csv'], createdAt: 'Mar 18', starred: true, time: 'Mar 18' },
  { id: 'p2', title: 'Customer churn by segment', datasetNames: ['customers.csv'], createdAt: 'Mar 17', starred: true, time: 'Mar 17' },
  { id: 'p3', title: 'Monthly revenue trend by region', datasetNames: ['sales_2024.csv', 'products.csv'], createdAt: 'Today', starred: false, time: '14:32' },
  { id: 'p4', title: 'Top 10 products last quarter', datasetNames: ['sales_2024.csv'], createdAt: 'Today', starred: false, time: '11:05' },
  { id: 'p5', title: 'Avg order value over time', datasetNames: ['sales_2024.csv'], createdAt: 'Yesterday', starred: false, time: 'Mar 20' },
  { id: 'p6', title: 'Outliers in Q3 sales data', datasetNames: ['sales_2024.csv'], createdAt: 'Yesterday', starred: false, time: 'Mar 20' },
  { id: 'p7', title: 'Conversion funnel analysis', datasetNames: ['funnel_data.csv'], createdAt: 'Yesterday', starred: false, time: 'Mar 20' },
  { id: 'p8', title: 'SKU profitability matrix', datasetNames: ['sales_2024.csv', 'products.csv'], createdAt: 'Last 7 days', starred: false, time: 'Mar 16' },
  { id: 'p9', title: 'Regional demand forecast', datasetNames: ['sales_2024.csv'], createdAt: 'Last 7 days', starred: false, time: 'Mar 15' },
  { id: 'p10', title: 'Inventory turnover rate', datasetNames: ['inventory.csv'], createdAt: 'Last 7 days', starred: false, time: 'Mar 14' },
]

export const useProjectStore = create<ProjectStore>((set) => ({
  projects: MOCK_PROJECTS,
  activeProjectId: 'p3',
  selectProject: (id) => set({ activeProjectId: id }),
  toggleStar: (id) =>
    set((s) => ({
      projects: s.projects.map((p) =>
        p.id === id ? { ...p, starred: !p.starred } : p
      ),
    })),
}))