function Code({ children }: { children: string }) {
  return <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">{children}</code>;
}

/** Full-page state when this browser holds no valid secret for the server. */
export function Locked() {
  return (
    <div role="alert" className="flex h-svh flex-col items-center justify-center gap-4 px-6 text-center">
      <h1 className="text-lg font-semibold">Open the link that Tracer prints in the terminal</h1>
      <p className="max-w-md text-sm text-muted-foreground">
        Tracer prints the link when it starts. Run <Code>npx tracer-sh</Code> and
        open the line that starts with <Code>Open http://</Code>.
        This browser then remembers the link.
      </p>
      <p className="max-w-md text-sm text-muted-foreground">
        For a remote server, add <Code>#t=</Code> and its token to this address.
      </p>
    </div>
  );
}
