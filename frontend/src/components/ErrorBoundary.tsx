import { Component, type ReactNode } from 'react'

interface Props {
  children: ReactNode
  fallback?: ReactNode
}

interface State {
  error: Error | null
}

/**
 * ErrorBoundary — wraps a subtree and catches any render/lifecycle errors.
 * Without this, a single render error unmounts the whole React tree and
 * shows the bare black body background.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: { componentStack: string }) {
    console.error('[ErrorBoundary] Caught render error:', error.message)
    console.error(info.componentStack)
  }

  render() {
    if (this.state.error) {
      if (this.props.fallback) return this.props.fallback

      return (
        <div style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 12,
          padding: 24,
        }}>
          <div style={{
            fontFamily: 'var(--mono)', fontSize: 12,
            color: 'var(--red)',
          }}>
            ⛔ rendering error
          </div>
          <div style={{
            fontFamily: 'var(--mono)', fontSize: 10,
            color: 'var(--text2)',
            maxWidth: 380, textAlign: 'center', lineHeight: 1.8,
          }}>
            {this.state.error.message}
          </div>
          <button
            onClick={() => this.setState({ error: null })}
            style={{
              fontFamily: 'var(--mono)', fontSize: 10,
              padding: '5px 14px', borderRadius: 5,
              border: '1px solid var(--border2)',
              background: 'var(--bg3)',
              color: 'var(--text2)',
              cursor: 'pointer',
            }}
          >
            retry
          </button>
        </div>
      )
    }

    return this.props.children
  }
}
