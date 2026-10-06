import { Component, type ErrorInfo, type ReactNode } from 'react'

interface State {
  failed: boolean
  attempt: number
}

/** 화면 한 칸이 던져도 다른 칸이 살아 있게 하는 error boundary. 다시 시도는 자식을 새 key로 다시 마운트한다. */
export class ScreenBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { failed: false, attempt: 0 }

  static getDerivedStateFromError(): Partial<State> {
    return { failed: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('화면을 그리지 못했다', error, info.componentStack)
  }

  private retry = (): void => {
    this.setState((s) => ({ failed: false, attempt: s.attempt + 1 }))
  }

  render(): ReactNode {
    if (this.state.failed) {
      return (
        <div role="alert" className="screen-error">
          <p>이 화면을 그리지 못했다</p>
          <button type="button" onClick={this.retry}>
            다시 시도
          </button>
        </div>
      )
    }
    return <div key={this.state.attempt} className="screen-boundary">{this.props.children}</div>
  }
}
