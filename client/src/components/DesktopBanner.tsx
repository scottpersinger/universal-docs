// The Local/Web banner of the desktop app (MCP Docs; docs/web-and-pdf.md): which kind of tab this is (a folder on
// this computer, or the hosted Universal Docs) and a switch to the other. The switch is an mcpdocs:// link, which
// desktop/main.js catches before it loads: the hosted page gets nothing of the app's to call. Shown only in the
// app, which marks its pages' user agent.
import { useAuth } from '../auth.tsx';

/** This page is in the desktop app, in a Local or a Web tab. */
export const inDesktopApp = (): boolean => typeof navigator !== 'undefined' && navigator.userAgent.includes('MCPDocs/');

/** A folder's path with the home folder as ~. */
export function shortPath(dir: string): string {
  return dir.replace(/^(\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:\\Users\\[^\\]+)(?=$|[/\\])/, '~');
}

export function DesktopBanner() {
  const { user, loading, local } = useAuth();
  if (!inDesktopApp() || loading) return null;
  const web = !local;
  return (
    <div className={`desktop-banner ${web ? 'desktop-banner-web' : 'desktop-banner-local'}`}>
      <span className="desktop-banner-kind">{web ? 'Web' : 'Local'}</span>
      <span className="desktop-banner-where" title={local?.dir}>
        {local ? shortPath(local.dir) : user ? user.email : 'Not signed in'}
      </span>
      <a className="desktop-banner-switch" href={`mcpdocs://switch?to=${web ? 'local' : 'web'}`} title={web ? 'Go to the folders on this computer' : 'Go to your files on the web (Universal Docs)'}>
        {web ? 'Open Local' : 'Open Web'}
      </a>
    </div>
  );
}
