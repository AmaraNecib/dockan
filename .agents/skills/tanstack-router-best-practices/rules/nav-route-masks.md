# nav-route-masks: Use Route Masks for Modal URLs

## Priority: LOW

## Explanation

Route masks let you display one URL while internally routing to another. This is
useful for modals, sheets, and overlays: the address bar can show a clean,
shareable URL while the underlying modal route renders. Masking only rewrites
the URL — it does not change which route or component renders — so a modal that
should also work as a full page needs both a full-page route and a modal route.

## Bad Example

```tsx
// Modal without proper URL handling
function PostList() {
  const [selectedPost, setSelectedPost] = useState<string | null>(null)

  return (
    <div>
      {posts.map(post => (
        <div key={post.id} onClick={() => setSelectedPost(post.id)}>
          {post.title}
        </div>
      ))}

      {selectedPost && (
        <Modal onClose={() => setSelectedPost(null)}>
          <PostDetail postId={selectedPost} />
        </Modal>
      )}
    </div>
  )
}

// Problems:
// - URL doesn't change when modal opens
// - Can't share link to modal
// - Back button doesn't close modal
// - Refresh loses modal state
```

## Good Example: Route Masks for Modal

The modal is its own route; the full page is a separate route. The displayed
(masked) URL is the full-page URL, so a copied link still identifies the post and
opens the full page once the mask state — which lives in `location.state` — is
gone.

```tsx
// routes/posts.tsx
export const Route = createFileRoute('/posts')({
  component: PostList,
})

function PostList() {
  const posts = usePosts()

  return (
    <div>
      {posts.map(post => (
        <Link
          key={post.id}
          // Real route: the modal
          to="/posts/$postId/modal"
          params={{ postId: post.id }}
          // Displayed URL: the canonical full-page URL for this post
          mask={{
            to: '/posts/$postId',
            params: { postId: post.id },
          }}
        >
          {post.title}
        </Link>
      ))}
      <Outlet />  {/* The modal route renders here while it is open */}
    </div>
  )
}

// routes/posts.$postId.tsx — full page; a shared/copied URL resolves here
export const Route = createFileRoute('/posts/$postId')({
  component: PostPage,
})

function PostPage() {
  const { postId } = Route.useParams()
  return (
    <div>
      <PostDetail postId={postId} />
      <Outlet />  {/* The modal route overlays the full page when open */}
    </div>
  )
}

// routes/posts.$postId.modal.tsx — the modal route
export const Route = createFileRoute('/posts/$postId/modal')({
  component: PostModal,
})

function PostModal() {
  const { postId } = Route.useParams()
  const navigate = useNavigate()

  return (
    <Modal onClose={() => navigate({ to: '/posts' })}>
      <PostDetail postId={postId} />
      {/* Dropping the modal child reveals the already-rendered full page */}
      <Link to="/posts/$postId" params={{ postId }}>
        Open full page
      </Link>
    </Modal>
  )
}

// User clicks a post:
// - Address bar shows /posts/123 (the masked URL)
// - The modal route /posts/123/modal renders on top of the full page
// - Copying /posts/123 and opening it fresh renders the full page, because
//   mask state is not persisted outside the browser history entry
```

## Good Example: With Search Params

```tsx
function PostList() {
  return (
    <div>
      {posts.map(post => (
        <Link
          key={post.id}
          to="/posts/$postId/modal"
          params={{ postId: post.id }}
          mask={{
            to: '/posts/$postId',
            params: { postId: post.id },
            search: { from: 'grid' },  // /posts/123?from=grid
          }}
        >
          {post.title}
        </Link>
      ))}
    </div>
  )
}
```

## Good Example: Programmatic Navigation with Mask

```tsx
function PostCard({ post }: { post: Post }) {
  const navigate = useNavigate()

  const openInModal = () => {
    navigate({
      // Real route: the modal
      to: '/posts/$postId/modal',
      params: { postId: post.id },
      // Displayed URL: the canonical full-page URL
      mask: {
        to: '/posts/$postId',
        params: { postId: post.id },
      },
    })
  }

  const openFullPage = () => {
    navigate({
      to: '/posts/$postId',
      params: { postId: post.id },
      // No mask - shows the real full-page URL
    })
  }

  return (
    <div>
      <h3>{post.title}</h3>
      <button onClick={openInModal}>Quick View</button>
      <button onClick={openFullPage}>Full Page</button>
    </div>
  )
}
```

## Good Example: Unmask on Interaction

```tsx
function PostModal() {
  const { postId } = Route.useParams()
  const navigate = useNavigate()

  const expandToFullPage = () => {
    // Drop the modal child; the URL is already the full-page URL
    navigate({
      to: '/posts/$postId',
      params: { postId },
      replace: true,  // Replace the masked history entry
    })
  }

  return (
    <Modal>
      <PostDetail postId={postId} />
      <button onClick={expandToFullPage}>
        Expand to full page
      </button>
    </Modal>
  )
}
```

## Route Mask Behavior

| Scenario | URL Shown | Actual Route |
|----------|-----------|--------------|
| Click masked link | Masked URL | The route being navigated to |
| Copy the address bar | Masked URL | The route being navigated to (until the history entry is gone) |
| Open a copied URL fresh | The copied URL | Whatever route that URL matches — mask state is not restored |
| Browser refresh | URL in the bar | Same route while the history entry survives; otherwise the URL's own route |
| Back button | Previous URL | Previous route |

## Context

- Masks are client-side only - the mask is stored in `location.state`, not in the URL
- A mask changes the displayed URL, not which route renders; give the modal and the full page their own routes
- Mask state survives a refresh while the history entry is alive, but a copied/shared URL loses it
- Back button navigates through history correctly
- Use for modals, side panels, quick views
- Masks can include different search params
