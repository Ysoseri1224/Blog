import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props { children: ReactNode; }
interface State { failed: boolean; }

/** 阅读工作区的最后一道隔离层：未知渲染异常也必须留下可恢复界面。 */
export class PublicErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('public_app_render_failed', { message: error.message, componentStack: info.componentStack });
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return <main className="public-error-fallback" role="alert">
      <p>blog · ysoseri.us</p>
      <h1>阅读工作区没有正确载入</h1>
      <span>文章仍然保存在服务器；可以刷新页面重新建立阅读现场。</span>
      <div>
        <button className="primary-button" onClick={() => location.reload()}>重新载入</button>
        <a className="secondary-button" href="/">返回博客</a>
      </div>
    </main>;
  }
}
