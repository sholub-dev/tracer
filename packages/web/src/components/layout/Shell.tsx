import { theme } from "../../lib/theme";

interface ShellProps {
  sidebar: React.ReactNode;
  children: React.ReactNode;
}

export function Shell({ sidebar, children }: ShellProps) {
  return (
    <div className={`flex h-screen ${theme.shell}`}>
      <aside className="w-52 flex-shrink-0 h-full">{sidebar}</aside>
      <main className="flex-1 overflow-auto">{children}</main>
    </div>
  );
}
