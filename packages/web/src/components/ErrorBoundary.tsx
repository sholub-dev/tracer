import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** Renders in place of the children after a render error. */
  fallback?: (error: Error) => ReactNode;
  /** A new value clears a caught error and renders the children again. */
  resetKey?: unknown;
}

interface State {
  error: Error | null;
  resetKey: unknown;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, resetKey: this.props.resetKey };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    return props.resetKey === state.resetKey ? null : { error: null, resetKey: props.resetKey };
  }
  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback(error);
    return (
      <div role="alert" className="p-2 text-[13px]/[18px] text-muted-foreground">
        This part failed to render
      </div>
    );
  }
}
