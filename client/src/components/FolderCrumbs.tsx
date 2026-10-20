import { Link } from 'react-router-dom';
import { folderTrail } from '../../../shared/folders.ts';
import { useAuth } from '../auth.tsx';
import { fromRecents, listingHref, RECENTS_HREF } from '../listing.ts';

export { lastListingHref } from '../listing.ts';

/**
 * Breadcrumbs for an open file: the top of the library and each folder down to the one the file is in,
 * each a link back to the file list there. The file's own name follows them in the page header.
 */
export function FolderCrumbs({ folder, onLeave }: { folder?: string; onLeave?: () => void }) {
  const { local } = useAuth();
  const root = local ? (local.dir.split(/[\\/]/).filter(Boolean).pop() ?? local.dir) : 'Your files';
  return (
    <nav className="folder-crumbs" aria-label="Folder">
      {/* A file opened from Recents leads back there first. */}
      {fromRecents() && (
        <span>
          <Link to={RECENTS_HREF} onClick={onLeave} title="Back to Recents">
            Recents
          </Link>
          <span className="crumb-sep">/</span>
        </span>
      )}
      {[{ name: root, path: '' }, ...folderTrail(folder ?? '')].map((f) => (
        <span key={f.path}>
          <Link to={listingHref(f.path)} onClick={onLeave} title={`Back to ${f.name}`}>
            {f.name}
          </Link>
          <span className="crumb-sep">/</span>
        </span>
      ))}
    </nav>
  );
}
