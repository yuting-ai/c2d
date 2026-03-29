import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

type Props = {
  text: string
  /** Optional extra class on wrapper (e.g. report vs chat) */
  className?: string
}

/**
 * Full Markdown for analyst replies and report conclusions (GFM tables, lists, emphasis).
 */
export function ChatMarkdown({ text, className = '' }: Props) {
  if (!text) return null
  return (
    <div className={`c2d-markdown ${className}`.trim()}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  )
}
