# load-parallel: Leverage Parallel Route Loading

## Priority: MEDIUM

## Explanation

TanStack Router loads nested route data in parallel, not sequentially. Structure your routes and loaders to maximize parallelization and avoid creating artificial waterfalls.

## Bad Example

```tsx
// Creating waterfall with dependent beforeLoad
export const Route = createFileRoute('/dashboard')({
  beforeLoad: async () => {
    const user = await fetchUser()        // 200ms
    const permissions = await fetchPermissions(user.id)  // 200ms
    const preferences = await fetchPreferences(user.id)  // 200ms
    // Total: 600ms (sequential)

    return { user, permissions, preferences }
  },
})

// Or awaiting independent requests one after another inside one loader
// routes/dashboard.tsx
export const Route = createFileRoute('/dashboard')({
  loader: async () => {
    const stats = await fetchStats()        // 200ms
    const activity = await fetchActivity()  // 200ms - could have run with stats
    // Total: 400ms (sequential)
    return { stats, activity }
  },
})
```

## Good Example: Parallel in Single Loader

```tsx
export const Route = createFileRoute('/dashboard')({
  beforeLoad: async () => {
    // All requests start simultaneously
    const [user, config] = await Promise.all([
      fetchUser(),          // 200ms
      fetchAppConfig(),     // 150ms
    ])
    // Total: 200ms (parallel)

    return { user, config }
  },
  loader: async ({ context }) => {
    // These also run in parallel with each other
    const [stats, activity, notifications] = await Promise.all([
      fetchDashboardStats(context.user.id),
      fetchRecentActivity(context.user.id),
      fetchNotifications(context.user.id),
    ])

    return { stats, activity, notifications }
  },
})
```

## Good Example: Parallel Nested Routes

```tsx
// Parent and child loaders run in PARALLEL
// routes/posts.tsx
export const Route = createFileRoute('/posts')({
  loader: async () => {
    // This runs...
    const categories = await fetchCategories()
    return { categories }
  },
})

// routes/posts/$postId.tsx
export const Route = createFileRoute('/posts/$postId')({
  loader: async ({ params }) => {
    // ...at the SAME TIME as this!
    const post = await fetchPost(params.postId)
    const comments = await fetchComments(params.postId)
    return { post, comments }
  },
})

// Navigation to /posts/123:
// - Both loaders start simultaneously
// - Total time = max(categoriesTime, postTime + commentsTime)
// - NOT categoriesTime + postTime + commentsTime
```

## Good Example: With TanStack Query

```tsx
// routes/posts.tsx
export const Route = createFileRoute('/posts')({
  loader: async ({ context: { queryClient } }) => {
    // These all start in parallel
    await Promise.all([
      queryClient.ensureQueryData(postQueries.list()),
      queryClient.ensureQueryData(categoryQueries.all()),
    ])
  },
})

// routes/posts/$postId.tsx
export const Route = createFileRoute('/posts/$postId')({
  loader: async ({ params, context: { queryClient } }) => {
    // Runs in parallel with parent loader
    await Promise.all([
      queryClient.ensureQueryData(postQueries.detail(params.postId)),
      queryClient.ensureQueryData(commentQueries.forPost(params.postId)),
    ])
  },
})
```

## Good Example: Streaming Non-Critical Data

```tsx
export const Route = createFileRoute('/posts/$postId')({
  loader: async ({ params, context: { queryClient } }) => {
    // Critical data - await
    const post = await queryClient.ensureQueryData(
      postQueries.detail(params.postId)
    )

    // Non-critical - start but don't await (stream in later)
    queryClient.prefetchQuery(commentQueries.forPost(params.postId))
    queryClient.prefetchQuery(relatedQueries.forPost(params.postId))

    return { post }
  },
  component: PostPage,
})

function PostPage() {
  const { post } = Route.useLoaderData()
  const { postId } = Route.useParams()

  // Critical data ready immediately
  // Non-critical loads in component with loading state
  const { data: comments, isPending } = useQuery(
    commentQueries.forPost(postId)
  )

  return (
    <article>
      <PostContent post={post} />
      {/* isPending, not isLoading: a first fetch paused offline stays pending */}
      {isPending ? (
        <CommentsSkeleton />
      ) : comments ? (
        <Comments data={comments} />
      ) : (
        <CommentsError />
      )}
    </article>
  )
}
```

## Route Loading Timeline

```
Navigation to /posts/123

Without parallelization (sequential loaders):
├─ beforeLoad (parent)  ████████
├─ beforeLoad (child)           ████
├─ loader (parent)                  ████████
├─ loader (child)                           ████████
└─ Render                                           █

With parallelization:
├─ beforeLoad (parent)  ████████
├─ beforeLoad (child)           ████
├─ loader (parent)                  ████████████
├─ loader (child)                   ████████████
└─ Render                                       █
```

## Context

- `beforeLoad` runs serially from parent to child (for auth, context setup)
- After every `beforeLoad` finishes, the loaders for all matched routes run in parallel
- Use `Promise.all` for parallel fetches within a single loader
- Parent context is available in child loaders (after beforeLoad)
- Prefetch non-critical data without awaiting for streaming
- Monitor network tab to verify parallelization
