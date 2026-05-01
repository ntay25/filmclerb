import {
  encodedSize,
  PinnedObject,
  type Sdk,
  type ShardProgress,
} from '@siafoundation/sia-storage'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { DATA_SHARDS, PARITY_SHARDS } from '../../lib/constants'
import { useAuthStore } from '../../stores/auth'
import { useToastStore } from '../../stores/toast'
import { CopyButton, copyToClipboard } from '../CopyLinkButton'

const CLAIMS_KEY = 'filmclerb-local-link-views'
const LINKS_KEY = 'filmclerb-local-viewer-links'
const DEFAULT_LINK_COUNT = 5
const LINK_LIFETIME_MS = 24 * 60 * 60 * 1000
const MAX_METADATA_BYTES = 1024

type ViewerLink = {
  id: string
  label: string
  url: string
  createdAt: number
  expiresAt: number
}

type ScreenerMetadata = {
  kind: 'filmclerb-film' | 'screenpass-film'
  schemaVersion: 1
  title: string
  fileName: string
  type: string
  size: number
  hash: string
  createdAt: number
  linkCount: number
  links?: ViewerLink[]
}

type Film = {
  id: string
  metadata: StoredScreenerMetadata
  links: ViewerLink[]
  object: PinnedObject
}

type StoredScreenerMetadata = Omit<ScreenerMetadata, 'links'>

type UploadProgress = {
  fileName: string
  fileSize: number
  shardsDone: number
  bytesUploaded: number
  encodedTotal: number
}

type DownloadProgress = {
  shardsDone: number
  bytesDownloaded: number
  totalBytes: number
}

type UnlockedFilm = {
  title: string
  type: string
  size: number
  linkUrl: string
  object: PinnedObject
  videoUrl: string | null
}

type LinkViewRecord = {
  firstViewedAt: number
  lastViewedAt: number
  views: number
}

type LinkViewMap = Record<string, LinkViewRecord>
type LinkMap = Record<string, ViewerLink[]>

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${parseFloat((bytes / k ** i).toFixed(1))} ${sizes[i]}`
}

function formatDateTime(ms: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(ms))
}

function decodeMetadata(bytes: Uint8Array): ScreenerMetadata | null {
  try {
    const parsed = JSON.parse(
      new TextDecoder().decode(bytes),
    ) as Partial<ScreenerMetadata>
    if (parsed.kind !== 'filmclerb-film' && parsed.kind !== 'screenpass-film') {
      return null
    }
    if (!parsed.title || typeof parsed.createdAt !== 'number') {
      return null
    }
    return {
      kind: parsed.kind,
      schemaVersion: 1,
      title: parsed.title,
      fileName: parsed.fileName ?? parsed.title,
      type: parsed.type ?? 'video/mp4',
      size: parsed.size ?? 0,
      hash: parsed.hash ?? '',
      createdAt: parsed.createdAt,
      linkCount: parsed.linkCount ?? parsed.links?.length ?? DEFAULT_LINK_COUNT,
      links: parsed.links,
    } as ScreenerMetadata
  } catch {
    return null
  }
}

function stripMetadataLinks(
  metadata: ScreenerMetadata,
): StoredScreenerMetadata {
  const { links: _links, ...storedMetadata } = metadata
  return storedMetadata
}

function encodeMetadata(metadata: StoredScreenerMetadata): Uint8Array {
  const encoder = new TextEncoder()
  const encoded = encoder.encode(JSON.stringify(metadata))
  if (encoded.length <= MAX_METADATA_BYTES) return encoded

  const compactMetadata: StoredScreenerMetadata = {
    ...metadata,
    title: metadata.title.slice(0, 120),
    fileName: metadata.fileName.slice(0, 120),
  }
  const compactEncoded = encoder.encode(JSON.stringify(compactMetadata))
  if (compactEncoded.length <= MAX_METADATA_BYTES) return compactEncoded

  throw new Error('Film title and filename are too long for Sia metadata.')
}

function readLinkViews(): LinkViewMap {
  try {
    return JSON.parse(localStorage.getItem(CLAIMS_KEY) ?? '{}') as LinkViewMap
  } catch {
    return {}
  }
}

function saveLinkViews(views: LinkViewMap) {
  localStorage.setItem(CLAIMS_KEY, JSON.stringify(views))
}

function readStoredLinks(): LinkMap {
  try {
    return JSON.parse(localStorage.getItem(LINKS_KEY) ?? '{}') as LinkMap
  } catch {
    return {}
  }
}

function saveStoredLinks(links: LinkMap) {
  localStorage.setItem(LINKS_KEY, JSON.stringify(links))
}

function buildViewerLinks(
  sdk: Sdk,
  object: PinnedObject,
  count: number,
  createdAt: number,
): ViewerLink[] {
  const expiresAt = createdAt + LINK_LIFETIME_MS
  return Array.from({ length: count }, (_, index) => {
    const linkExpiresAt = Math.max(createdAt + 60_000, expiresAt - index * 1000)
    return {
      id: crypto.randomUUID(),
      label: `Link ${String(index + 1).padStart(2, '0')}`,
      url: sdk.shareObject(object, new Date(linkExpiresAt)),
      createdAt,
      expiresAt: linkExpiresAt,
    }
  })
}

function getOrCreateViewerLinks(
  sdk: Sdk,
  object: PinnedObject,
  metadata: StoredScreenerMetadata,
): ViewerLink[] {
  const objectId = object.id()
  const storedLinks = readStoredLinks()
  const links = storedLinks[objectId]
  if (links?.length === metadata.linkCount) return links

  const nextLinks = buildViewerLinks(
    sdk,
    object,
    metadata.linkCount,
    metadata.createdAt,
  )
  saveStoredLinks({ ...storedLinks, [objectId]: nextLinks })
  return nextLinks
}

export function FilmClerbStudioV2() {
  const sdk = useAuthStore((s) => s.sdk)
  const addToast = useToastStore((s) => s.addToast)
  const [films, setFilms] = useState<Film[]>([])
  const [selectedFilmId, setSelectedFilmId] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [linkCount, setLinkCount] = useState(DEFAULT_LINK_COUNT)
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [activeUpload, setActiveUpload] = useState<UploadProgress | null>(null)
  const [downloading, setDownloading] = useState(false)
  const [downloadProgress, setDownloadProgress] =
    useState<DownloadProgress | null>(null)
  const [shareInput, setShareInput] = useState('')
  const [unlockedFilm, setUnlockedFilm] = useState<UnlockedFilm | null>(null)
  const [linkViews, setLinkViews] = useState<LinkViewMap>(() => readLinkViews())
  const [error, setError] = useState<string | null>(null)
  const videoUrlRef = useRef<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const selectedFilm = useMemo(
    () => films.find((film) => film.id === selectedFilmId) ?? films[0] ?? null,
    [films, selectedFilmId],
  )

  const uploadPercent = activeUpload
    ? Math.min(
        100,
        Math.round(
          (activeUpload.bytesUploaded / activeUpload.encodedTotal) * 100,
        ),
      )
    : 0

  const loadFilms = useCallback(async () => {
    if (!sdk) return
    try {
      const events = await sdk.objectEvents(undefined, 100)
      const loaded: Film[] = []
      for (const event of events) {
        if (event.deleted || !event.object) continue
        const decodedMetadata = decodeMetadata(event.object.metadata())
        if (decodedMetadata) {
          const metadata = stripMetadataLinks(decodedMetadata)
          const links =
            decodedMetadata.links && decodedMetadata.links.length > 0
              ? decodedMetadata.links
              : getOrCreateViewerLinks(sdk, event.object, metadata)
          loaded.push({ id: event.id, metadata, links, object: event.object })
        }
      }
      loaded.sort((a, b) => b.metadata.createdAt - a.metadata.createdAt)
      setFilms(loaded)
      setSelectedFilmId((current) => current ?? loaded[0]?.id ?? null)
    } catch (e) {
      console.error('Failed to load screeners:', e)
    }
  }, [sdk])

  useEffect(() => {
    loadFilms()
  }, [loadFilms])

  useEffect(() => {
    return () => {
      if (videoUrlRef.current) URL.revokeObjectURL(videoUrlRef.current)
    }
  }, [])

  function recordView(linkUrl: string) {
    const now = Date.now()
    setLinkViews((prev) => {
      const next: LinkViewMap = {
        ...prev,
        [linkUrl]: prev[linkUrl]
          ? {
              ...prev[linkUrl],
              lastViewedAt: now,
              views: prev[linkUrl].views + 1,
            }
          : { firstViewedAt: now, lastViewedAt: now, views: 1 },
      }
      saveLinkViews(next)
      return next
    })
  }

  async function uploadFilm() {
    if (!sdk || !selectedFile || uploading) return
    if (!selectedFile.type.startsWith('video/')) {
      setError('Pick a video file for the screener.')
      return
    }

    setUploading(true)
    setError(null)
    const filmTitle = title.trim() || selectedFile.name.replace(/\.[^.]+$/, '')
    const limitedLinkCount = Math.min(Math.max(linkCount, 1), 25)
    const createdAt = Date.now()
    const encodedTotal = encodedSize(
      selectedFile.size,
      DATA_SHARDS,
      PARITY_SHARDS,
    )
    setActiveUpload({
      fileName: selectedFile.name,
      fileSize: selectedFile.size,
      shardsDone: 0,
      bytesUploaded: 0,
      encodedTotal,
    })

    try {
      const hashBuffer = await crypto.subtle.digest(
        'SHA-256',
        await selectedFile.arrayBuffer(),
      )
      const hash = new Uint8Array(hashBuffer).toHex()
      const object = new PinnedObject()
      let shardsDone = 0
      let bytesUploaded = 0

      const pinnedObject = await sdk.upload(object, selectedFile.stream(), {
        maxInflight: 10,
        dataShards: DATA_SHARDS,
        parityShards: PARITY_SHARDS,
        onShardUploaded: (progress: ShardProgress) => {
          shardsDone++
          bytesUploaded += progress.shardSize
          setActiveUpload({
            fileName: selectedFile.name,
            fileSize: selectedFile.size,
            shardsDone,
            bytesUploaded,
            encodedTotal,
          })
        },
      })

      const metadata: StoredScreenerMetadata = {
        kind: 'filmclerb-film',
        schemaVersion: 1,
        title: filmTitle,
        fileName: selectedFile.name,
        type: selectedFile.type,
        size: selectedFile.size,
        hash,
        createdAt,
        linkCount: limitedLinkCount,
      }

      const links = buildViewerLinks(
        sdk,
        pinnedObject,
        limitedLinkCount,
        createdAt,
      )
      saveStoredLinks({
        ...readStoredLinks(),
        [pinnedObject.id()]: links,
      })
      pinnedObject.updateMetadata(encodeMetadata(metadata))
      await sdk.pinObject(pinnedObject)
      await sdk.updateObjectMetadata(pinnedObject)

      const nextFilm = {
        id: pinnedObject.id(),
        metadata,
        links,
        object: pinnedObject,
      }
      setFilms((prev) => [nextFilm, ...prev])
      setSelectedFilmId(nextFilm.id)
      setTitle('')
      setSelectedFile(null)
      setLinkCount(DEFAULT_LINK_COUNT)
      if (fileInputRef.current) fileInputRef.current.value = ''
      addToast(`${limitedLinkCount} one-day share links created`)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed')
    } finally {
      setUploading(false)
      setActiveUpload(null)
    }
  }

  async function deleteFilm(film: Film) {
    if (!sdk) return
    setError(null)
    try {
      await sdk.deleteObject(film.id)
      setFilms((prev) => prev.filter((item) => item.id !== film.id))
      setSelectedFilmId((current) => (current === film.id ? null : current))
      addToast('Screener removed')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed')
    }
  }

  function formatShareLinks(film: Film) {
    return film.links
      .map((link) => `${film.metadata.title} - ${link.label}\n${link.url}`)
      .join('\n\n')
  }

  async function copyAllLinks(film: Film) {
    const copied = await copyToClipboard(formatShareLinks(film))
    addToast(copied ? 'All share links copied' : 'Select the links manually')
  }

  async function unlockShareLink() {
    if (!sdk) return
    const linkUrl = shareInput.trim()
    if (!linkUrl) return
    setError(null)
    setUnlockedFilm(null)
    if (videoUrlRef.current) {
      URL.revokeObjectURL(videoUrlRef.current)
      videoUrlRef.current = null
    }

    try {
      const object = await sdk.sharedObject(linkUrl)
      const metadata = decodeMetadata(object.metadata())
      setUnlockedFilm({
        title: metadata?.title ?? 'Shared screener',
        type: metadata?.type ?? 'video/mp4',
        size: metadata?.size ?? 0,
        linkUrl,
        object,
        videoUrl: null,
      })
      recordView(linkUrl)
      addToast('Share link unlocked')
    } catch (e) {
      setError(
        e instanceof Error ? e.message : 'Could not unlock that Sia share link',
      )
    }
  }

  async function loadVideo() {
    if (!sdk || !unlockedFilm || downloading) return
    setDownloading(true)
    setDownloadProgress({
      shardsDone: 0,
      bytesDownloaded: 0,
      totalBytes: unlockedFilm.size,
    })

    try {
      let shardsDone = 0
      const stream = sdk.download(unlockedFilm.object, {
        maxInflight: 10,
        onShardDownloaded: () => {
          shardsDone++
          setDownloadProgress((prev) => ({
            shardsDone,
            bytesDownloaded: prev?.bytesDownloaded ?? 0,
            totalBytes: unlockedFilm.size,
          }))
        },
      })

      const reader = stream.getReader()
      const chunks: Uint8Array[] = []
      let bytesDownloaded = 0
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
        bytesDownloaded += value.length
        setDownloadProgress((prev) => ({
          shardsDone: prev?.shardsDone ?? 0,
          bytesDownloaded,
          totalBytes: unlockedFilm.size,
        }))
      }

      const blob = new Blob(chunks as BlobPart[], { type: unlockedFilm.type })
      if (videoUrlRef.current) URL.revokeObjectURL(videoUrlRef.current)
      const videoUrl = URL.createObjectURL(blob)
      videoUrlRef.current = videoUrl
      setUnlockedFilm((prev) => (prev ? { ...prev, videoUrl } : prev))
      recordView(unlockedFilm.linkUrl)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Playback failed')
    } finally {
      setDownloading(false)
      setDownloadProgress(null)
    }
  }

  function handleFile(file: File | null) {
    if (!file) return
    setSelectedFile(file)
    setTitle((current) => current || file.name.replace(/\.[^.]+$/, ''))
  }

  return (
    <main className="flex-1 bg-[#f7f5f0]">
      <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 sm:py-8">
        <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-xs font-medium uppercase tracking-[0.18em] text-emerald-700">
              Private film screeners
            </p>
            <h1 className="mt-1 text-3xl font-semibold tracking-tight text-neutral-950">
              FilmClerb
            </h1>
          </div>
          <div className="grid grid-cols-3 divide-x divide-neutral-200 overflow-hidden rounded-lg border border-neutral-200 bg-white text-center shadow-sm">
            <div className="px-4 py-3">
              <p className="text-lg font-semibold text-neutral-950">
                {films.length}
              </p>
              <p className="text-xs text-neutral-500">Films</p>
            </div>
            <div className="px-4 py-3">
              <p className="text-lg font-semibold text-neutral-950">
                {films.reduce((sum, film) => sum + film.metadata.linkCount, 0)}
              </p>
              <p className="text-xs text-neutral-500">Links</p>
            </div>
            <div className="px-4 py-3">
              <p className="text-lg font-semibold text-neutral-950">
                {Object.keys(linkViews).length}
              </p>
              <p className="text-xs text-neutral-500">Opened here</p>
            </div>
          </div>
        </div>

        {error && (
          <div className="mb-4 flex items-center justify-between rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
            <span>{error}</span>
            <button
              type="button"
              onClick={() => setError(null)}
              className="ml-4 text-xs font-medium text-rose-700 hover:text-rose-950"
            >
              Dismiss
            </button>
          </div>
        )}

        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_420px]">
          <section className="space-y-5">
            <div className="rounded-lg border border-neutral-200 bg-white p-5 shadow-sm">
              <div className="mb-4 flex items-center justify-between gap-4">
                <div>
                  <h2 className="text-base font-semibold text-neutral-950">
                    New screener
                  </h2>
                  <p className="text-sm text-neutral-500">
                    Upload one video and create one-day Sia share links.
                  </p>
                </div>
                <span className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-700">
                  Browser only
                </span>
              </div>

              <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_140px]">
                <label className="space-y-1.5">
                  <span className="text-xs font-medium text-neutral-600">
                    Film title
                  </span>
                  <input
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="Midnight Program"
                    className="h-10 w-full rounded-md border border-neutral-300 px-3 text-sm outline-none transition focus:border-emerald-600 focus:ring-2 focus:ring-emerald-100"
                  />
                </label>
                <label className="space-y-1.5">
                  <span className="text-xs font-medium text-neutral-600">
                    Share links
                  </span>
                  <input
                    value={linkCount}
                    min={1}
                    max={25}
                    type="number"
                    onChange={(e) => setLinkCount(Number(e.target.value))}
                    className="h-10 w-full rounded-md border border-neutral-300 px-3 text-sm outline-none transition focus:border-emerald-600 focus:ring-2 focus:ring-emerald-100"
                  />
                </label>
              </div>

              <label
                onDrop={(e) => {
                  e.preventDefault()
                  setDragOver(false)
                  handleFile(e.dataTransfer.files[0] ?? null)
                }}
                onDragOver={(e) => {
                  e.preventDefault()
                  setDragOver(true)
                }}
                onDragLeave={(e) => {
                  e.preventDefault()
                  setDragOver(false)
                }}
                className={`mt-4 block rounded-lg border-2 border-dashed p-8 text-center transition ${
                  dragOver
                    ? 'border-emerald-600 bg-emerald-50'
                    : 'border-neutral-300 bg-neutral-50 hover:border-neutral-400'
                } ${uploading ? 'cursor-default opacity-80' : 'cursor-pointer'}`}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="video/*"
                  className="hidden"
                  disabled={uploading}
                  onChange={(e) => handleFile(e.target.files?.[0] ?? null)}
                />
                {activeUpload ? (
                  <div className="space-y-4">
                    <p className="text-sm text-neutral-700">
                      Uploading{' '}
                      <span className="font-medium text-neutral-950">
                        {activeUpload.fileName}
                      </span>{' '}
                      <span className="text-neutral-500">
                        ({formatBytes(activeUpload.fileSize)})
                      </span>
                    </p>
                    <div className="mx-auto h-2 w-full max-w-sm overflow-hidden rounded-full bg-neutral-200">
                      {activeUpload.shardsDone === 0 ? (
                        <div className="h-full w-1/4 animate-indeterminate rounded-full bg-emerald-600" />
                      ) : (
                        <div
                          className="h-full rounded-full bg-emerald-600 transition-all duration-300"
                          style={{ width: `${uploadPercent}%` }}
                        />
                      )}
                    </div>
                    <p className="text-xs font-mono text-neutral-500">
                      {activeUpload.shardsDone} shards |{' '}
                      {formatBytes(
                        (activeUpload.bytesUploaded /
                          activeUpload.encodedTotal) *
                          activeUpload.fileSize,
                      )}{' '}
                      / {formatBytes(activeUpload.fileSize)}
                    </p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-white text-neutral-500 shadow-sm">
                      <svg
                        className="h-5 w-5"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        aria-hidden="true"
                      >
                        <path d="M12 16V4m0 0-4 4m4-4 4 4" />
                        <path d="M20 16v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-2" />
                      </svg>
                    </div>
                    <p className="text-sm font-medium text-neutral-800">
                      {selectedFile ? selectedFile.name : 'Choose a video'}
                    </p>
                    <p className="text-xs text-neutral-500">
                      {selectedFile
                        ? `${formatBytes(selectedFile.size)} | ${
                            selectedFile.type || 'video'
                          }`
                        : 'MP4, MOV, or WebM'}
                    </p>
                  </div>
                )}
              </label>

              <div className="mt-4 flex items-center justify-end gap-3">
                <button
                  type="button"
                  onClick={() => {
                    setSelectedFile(null)
                    setTitle('')
                    if (fileInputRef.current) fileInputRef.current.value = ''
                  }}
                  disabled={uploading || !selectedFile}
                  className="rounded-md px-3 py-2 text-sm font-medium text-neutral-500 transition hover:text-neutral-950 disabled:cursor-default disabled:opacity-40"
                >
                  Clear
                </button>
                <button
                  type="button"
                  onClick={uploadFilm}
                  disabled={uploading || !selectedFile}
                  className="inline-flex min-w-36 items-center justify-center rounded-md bg-neutral-950 px-4 py-2 text-sm font-medium text-white transition hover:bg-neutral-800 disabled:cursor-default disabled:opacity-40"
                >
                  {uploading ? 'Uploading' : 'Create links'}
                </button>
              </div>
            </div>

            <div className="rounded-lg border border-neutral-200 bg-white shadow-sm">
              <div className="flex items-center justify-between border-b border-neutral-200 px-5 py-4">
                <div>
                  <h2 className="text-base font-semibold text-neutral-950">
                    Film catalog
                  </h2>
                  <p className="text-sm text-neutral-500">
                    {films.length === 0
                      ? 'No screeners yet'
                      : `${films.length} encrypted screener${
                          films.length === 1 ? '' : 's'
                        }`}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={loadFilms}
                  className="rounded-md border border-neutral-200 px-3 py-2 text-sm font-medium text-neutral-600 transition hover:border-neutral-300 hover:text-neutral-950"
                >
                  Refresh
                </button>
              </div>

              {films.length === 0 ? (
                <div className="px-5 py-12 text-center text-sm text-neutral-500">
                  Upload a short video to create your first five links.
                </div>
              ) : (
                <div className="divide-y divide-neutral-100">
                  {films.map((film) => {
                    const isSelected = selectedFilm?.id === film.id
                    const firstExpiry = film.links[0]?.expiresAt
                    return (
                      <button
                        key={film.id}
                        type="button"
                        onClick={() => setSelectedFilmId(film.id)}
                        className={`grid w-full gap-3 px-5 py-4 text-left transition sm:grid-cols-[minmax(0,1fr)_auto] ${
                          isSelected
                            ? 'bg-emerald-50/70'
                            : 'bg-white hover:bg-neutral-50'
                        }`}
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium text-neutral-950">
                            {film.metadata.title}
                          </span>
                          <span className="mt-1 block text-xs text-neutral-500">
                            {formatBytes(film.metadata.size)} |{' '}
                            {film.metadata.linkCount} links
                            {firstExpiry
                              ? ` | expires ${formatDateTime(firstExpiry)}`
                              : ''}
                          </span>
                        </span>
                        <span className="flex items-center gap-3 text-xs text-neutral-500">
                          <span className="font-mono">
                            {film.metadata.hash.slice(0, 8)}
                          </span>
                          <span
                            className={`h-2 w-2 rounded-full ${
                              isSelected ? 'bg-emerald-600' : 'bg-neutral-300'
                            }`}
                          />
                        </span>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          </section>

          <aside className="space-y-5">
            <div className="rounded-lg border border-neutral-200 bg-white shadow-sm">
              <div className="flex items-start justify-between gap-3 border-b border-neutral-200 px-5 py-4">
                <div>
                  <h2 className="text-base font-semibold text-neutral-950">
                    Viewer links
                  </h2>
                  <p className="text-sm text-neutral-500">
                    {selectedFilm
                      ? selectedFilm.metadata.title
                      : 'Select a film to see links'}
                  </p>
                </div>
                {selectedFilm && (
                  <button
                    type="button"
                    onClick={() => copyAllLinks(selectedFilm)}
                    className="rounded-md border border-neutral-200 px-3 py-2 text-sm font-medium text-neutral-600 transition hover:border-neutral-300 hover:text-neutral-950"
                  >
                    Copy links
                  </button>
                )}
              </div>

              {selectedFilm ? (
                <div className="max-h-[560px] divide-y divide-neutral-100 overflow-auto">
                  <div className="space-y-2 bg-emerald-50/40 px-5 py-4">
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-xs font-semibold uppercase tracking-[0.14em] text-emerald-800">
                        All viewer links
                      </p>
                      <CopyButton
                        value={formatShareLinks(selectedFilm)}
                        label="Viewer links copied"
                      />
                    </div>
                    <textarea
                      readOnly
                      aria-label="All viewer links"
                      data-testid="all-viewer-links"
                      value={formatShareLinks(selectedFilm)}
                      onFocus={(event) => event.currentTarget.select()}
                      onClick={(event) => event.currentTarget.select()}
                      rows={8}
                      className="w-full resize-none rounded-md border border-emerald-200 bg-white px-3 py-2 font-mono text-[11px] leading-5 text-neutral-700 outline-none transition focus:border-emerald-600 focus:ring-2 focus:ring-emerald-100"
                    />
                  </div>
                  {selectedFilm.links.map((link) => {
                    const view = linkViews[link.url]
                    const inputId = `viewer-link-${link.id}`
                    return (
                      <div key={link.id} className="space-y-2 px-5 py-3">
                        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <p className="text-sm font-medium text-neutral-900">
                                {link.label}
                              </p>
                              {view && (
                                <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">
                                  {view.views} opens
                                </span>
                              )}
                            </div>
                            <p className="mt-1 truncate text-xs text-neutral-500">
                              Expires {formatDateTime(link.expiresAt)}
                            </p>
                          </div>
                          <CopyButton
                            value={link.url}
                            label={`${link.label} copied`}
                          />
                        </div>
                        <input
                          id={inputId}
                          type="text"
                          readOnly
                          aria-label={`${link.label} share URL`}
                          data-testid={inputId}
                          value={link.url}
                          onFocus={(event) => event.currentTarget.select()}
                          onClick={(event) => event.currentTarget.select()}
                          className="w-full rounded-md border border-neutral-200 bg-neutral-50 px-2 py-1.5 font-mono text-[11px] text-neutral-600 outline-none transition focus:border-emerald-500 focus:bg-white focus:ring-2 focus:ring-emerald-100"
                        />
                      </div>
                    )
                  })}
                </div>
              ) : (
                <div className="px-5 py-10 text-center text-sm text-neutral-500">
                  Links will appear after upload.
                </div>
              )}
            </div>

            <div className="rounded-lg border border-neutral-200 bg-white p-5 shadow-sm">
              <h2 className="text-base font-semibold text-neutral-950">
                Viewer mode
              </h2>
              <p className="mt-1 text-sm text-neutral-500">
                Paste a Sia share link to unlock and watch the film.
              </p>
              <textarea
                value={shareInput}
                onChange={(e) => setShareInput(e.target.value)}
                placeholder="Paste one-day share link"
                className="mt-4 min-h-24 w-full resize-y rounded-md border border-neutral-300 px-3 py-2 font-mono text-xs outline-none transition focus:border-emerald-600 focus:ring-2 focus:ring-emerald-100"
              />
              <div className="mt-3 flex justify-end">
                <button
                  type="button"
                  onClick={unlockShareLink}
                  className="rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white transition hover:bg-emerald-800"
                >
                  Unlock link
                </button>
              </div>

              {unlockedFilm && (
                <div className="mt-5 space-y-4 border-t border-neutral-200 pt-5">
                  <div>
                    <p className="text-sm font-medium text-neutral-950">
                      {unlockedFilm.title}
                    </p>
                    <p className="mt-1 text-xs text-neutral-500">
                      {unlockedFilm.size
                        ? `${formatBytes(unlockedFilm.size)} | `
                        : ''}
                      rewatch allowed until the link expires
                    </p>
                  </div>

                  {unlockedFilm.videoUrl ? (
                    // Festival screeners usually burn captions into the video file.
                    // biome-ignore lint/a11y/useMediaCaption: Uploaded screener files are expected to include burned-in captions when needed.
                    <video
                      src={unlockedFilm.videoUrl}
                      controls
                      aria-label={`${unlockedFilm.title} screener video`}
                      className="aspect-video w-full rounded-md bg-black"
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={loadVideo}
                      disabled={downloading}
                      className="flex w-full items-center justify-center rounded-md bg-neutral-950 px-4 py-3 text-sm font-medium text-white transition hover:bg-neutral-800 disabled:cursor-default disabled:opacity-50"
                    >
                      {downloading ? 'Loading film' : 'Load film'}
                    </button>
                  )}

                  {downloadProgress && (
                    <div>
                      <div className="h-2 overflow-hidden rounded-full bg-neutral-200">
                        <div
                          className="h-full rounded-full bg-emerald-600 transition-all duration-300"
                          style={{
                            width: `${Math.min(
                              100,
                              Math.round(
                                (downloadProgress.bytesDownloaded /
                                  Math.max(downloadProgress.totalBytes, 1)) *
                                  100,
                              ),
                            )}%`,
                          }}
                        />
                      </div>
                      <p className="mt-2 text-xs font-mono text-neutral-500">
                        {formatBytes(downloadProgress.bytesDownloaded)} /{' '}
                        {formatBytes(downloadProgress.totalBytes)} |{' '}
                        {downloadProgress.shardsDone} shards
                      </p>
                    </div>
                  )}
                </div>
              )}
            </div>

            {selectedFilm && (
              <button
                type="button"
                onClick={() => deleteFilm(selectedFilm)}
                className="w-full rounded-md border border-rose-200 bg-rose-50 px-4 py-2 text-sm font-medium text-rose-700 transition hover:border-rose-300 hover:bg-rose-100"
              >
                Remove selected screener
              </button>
            )}
          </aside>
        </div>
      </div>
    </main>
  )
}
