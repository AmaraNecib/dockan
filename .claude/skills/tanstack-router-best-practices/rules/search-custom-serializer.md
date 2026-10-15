# search-custom-serializer: Configure Custom Search Param Serializers

## Priority: LOW

## Explanation

By default, TanStack Router serializes search params as JSON. For cleaner URLs or compatibility with external systems, you can provide custom serializers using libraries like `qs`, `query-string`, or your own implementation.

## Bad Example

```tsx
// Default JSON serialization creates ugly URLs
// URL: /products?filters=%7B%22category%22%3A%22electronics%22%2C%22inStock%22%3Atrue%7D

// Or manually parsing/serializing inconsistently
function ProductList() {
  const searchParams = new URLSearchParams(window.location.search)
  const filters = JSON.parse(searchParams.get('filters') || '{}')
  // Inconsistent with router's handling
}
```

## Good Example: Using JSURL for Compact URLs

```tsx
import { createRouter } from '@tanstack/react-router'
import JSURL from 'jsurl2'

const router = createRouter({
  routeTree,
  // Top-level callbacks: stringifySearch returns the query string *with* its
  // leading '?', and parseSearch receives it with the leading '?'.
  stringifySearch: (search) => {
    if (Object.keys(search).length === 0) return ''
    const query = JSURL.stringify(search)
    return query ? `?${query}` : ''
  },
  parseSearch: (searchString) => {
    const query = searchString.replace(/^\?/, '')
    return query ? JSURL.parse(query) || {} : {}
  },
})

// URL: /products?~(category~'electronics~inStock~true)
// Much shorter than JSON!
```

## Good Example: Using query-string for Flat Params

```tsx
import { createRouter } from '@tanstack/react-router'
import queryString from 'query-string'

const router = createRouter({
  routeTree,
  stringifySearch: (search) => {
    const query = queryString.stringify(search, {
      arrayFormat: 'bracket',
      skipNull: true,
    })
    return query ? `?${query}` : ''
  },
  parseSearch: (searchString) =>
    // query-string strips a leading '?' for us
    queryString.parse(searchString, {
      arrayFormat: 'bracket',
      parseBooleans: true,
      parseNumbers: true,
    }),
})

// URL: /products?category=electronics&inStock=true&tags[]=sale&tags[]=new
// Traditional query string format
```

## Good Example: Using qs for Nested Objects

```tsx
import { createRouter } from '@tanstack/react-router'
import qs from 'qs'

const router = createRouter({
  routeTree,
  stringifySearch: (search) => {
    const query = qs.stringify(search, {
      encodeValuesOnly: true,
      arrayFormat: 'brackets',
    })
    return query ? `?${query}` : ''
  },
  parseSearch: (searchString) =>
    qs.parse(searchString, {
      // ignoreQueryPrefix drops the leading '?'
      ignoreQueryPrefix: true,
      // A custom decoder REPLACES qs's default percent-decoding, so call the
      // defaultDecoder first: otherwise '%20' and Arabic text stay escaped and
      // never round-trip.
      decoder(value, defaultDecoder) {
        const decoded = defaultDecoder(value)
        // Parse booleans and numbers
        if (decoded === 'true') return true
        if (decoded === 'false') return false
        if (/^-?\d+$/.test(decoded)) return parseInt(decoded, 10)
        return decoded
      },
    }),
})

// URL: /products?filters[category]=electronics&filters[price][min]=100&filters[price][max]=500
```

## Good Example: Base64 for Complex State

```tsx
import { createRouter } from '@tanstack/react-router'

const router = createRouter({
  routeTree,
  stringifySearch: (search) => {
    if (Object.keys(search).length === 0) return ''
    // btoa only accepts byte-valued characters, so encode the JSON to UTF-8
    // bytes first: this keeps non-Latin text (e.g. Arabic) intact.
    const json = JSON.stringify(search)
    const bytes = new TextEncoder().encode(json)
    let binary = ''
    for (const byte of bytes) binary += String.fromCharCode(byte)
    // base64url: '+' would be read as a space in a query string
    const base64 = btoa(binary)
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
    return `?${base64}`
  },
  parseSearch: (searchString) => {
    // Reverse the UTF-8 -> Base64url step before parsing the JSON
    const encoded = searchString.replace(/^\?/, '')
    if (!encoded) return {}
    try {
      const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/')
      const binary = atob(base64)
      const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
      return JSON.parse(new TextDecoder().decode(bytes))
    } catch {
      return {}
    }
  },
})

// URL: /products?eyJjYXRlZ29yeSI6ImVsZWN0cm9uaWNzIn0
// Opaque but compact, URL-safe, and reversible for any Unicode payload
```

## Good Example: Hybrid Approach

```tsx
// Some params as regular query, complex ones as JSON
import { createRouter } from '@tanstack/react-router'

const router = createRouter({
  routeTree,
  stringifySearch: (search) => {
    const { filters, ...simple } = search
    const params = new URLSearchParams()

    // Simple values as regular params
    Object.entries(simple).forEach(([key, value]) => {
      if (value !== undefined) {
        params.set(key, String(value))
      }
    })

    // Complex filters as JSON
    if (filters && Object.keys(filters).length > 0) {
      params.set('filters', JSON.stringify(filters))
    }

    const query = params.toString()
    return query ? `?${query}` : ''
  },
  parseSearch: (searchString) => {
    // URLSearchParams tolerates a leading '?'
    const params = new URLSearchParams(searchString)
    const result: Record<string, unknown> = {}

    params.forEach((value, key) => {
      if (key === 'filters') {
        // URL-controlled JSON: never let a malformed value throw before
        // validateSearch can supply a fallback.
        try {
          result.filters = JSON.parse(value)
        } catch {
          result.filters = undefined
        }
      } else if (value === 'true') {
        result[key] = true
      } else if (value === 'false') {
        result[key] = false
      } else if (/^-?\d+$/.test(value)) {
        result[key] = parseInt(value, 10)
      } else {
        result[key] = value
      }
    })

    return result
  },
})

// URL: /products?page=1&sort=price&filters=%7B%22category%22%3A%22electronics%22%2C%22inStock%22%3Atrue%7D
```

## Serializer Comparison

| Library | URL Style | Best For |
|---------|-----------|----------|
| Default (JSON) | `?data=%7B...%7D` | TypeScript safety |
| jsurl2 | `?~(key~'value)` | Compact, readable |
| query-string | `?key=value&arr[]=1` | Traditional APIs |
| qs | `?obj[nested]=value` | Deep nesting |
| Base64 | `?eyJrZXkiOiJ2YWx1ZSJ9` | Opaque, compact |

## Context

- Custom serializers apply globally to all routes
- `stringifySearch` must return the query string *including* the leading `?`; `parseSearch` receives the string *including* the `?`
- The `stringifySearchWith`/`parseSearchWith` helpers from `@tanstack/react-router` handle the `?` and URL-encoding if you would rather not do it by hand
- Route-level `validateSearch` still works after parsing
- Consider URL length limits (~2000 chars for safe cross-browser)
- SEO: Search engines may not understand custom formats
- Bookmarkability: Users can't easily modify opaque URLs
- Debugging: JSON is easier to read in browser devtools
