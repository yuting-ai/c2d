import { useCallback, useRef } from 'react'

interface ResizerProps {
  side: 'left' | 'right'
  targetRef: React.RefObject<HTMLDivElement | null>
  defaultWidth?: number
}

export default function Resizer({ side, targetRef, defaultWidth }: ResizerProps) {
  const dragging = useRef(false)

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const target = targetRef.current
    if (!target) return

    const startX = e.clientX
    const startW = target.getBoundingClientRect().width
    dragging.current = true
    document.body.classList.add('resizing')

    const onMove = (e: MouseEvent) => {
      const dx = e.clientX - startX
      if (side === 'left') {
        target.style.width = Math.max(160, Math.min(480, startW + dx)) + 'px'
      } else {
        const parent = target.parentElement
        if (!parent) return
        const maxW = parent.getBoundingClientRect().width * 0.75
        const minW = parent.getBoundingClientRect().width * 0.25
        const newW = Math.max(minW, Math.min(maxW, startW - dx))
        target.style.flex = 'none'
        target.style.width = newW + 'px'
      }
    }

    const onUp = () => {
      dragging.current = false
      document.body.classList.remove('resizing')
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [side, targetRef])

  const onDoubleClick = useCallback(() => {
    const target = targetRef.current
    if (!target) return
    if (side === 'left') {
      target.style.width = (defaultWidth || 240) + 'px'
    } else {
      target.style.width = ''
      target.style.flex = ''
    }
  }, [side, targetRef, defaultWidth])

  return (
    <div
      className="resizer"
      onMouseDown={onMouseDown}
      onDoubleClick={onDoubleClick}
    />
  )
}