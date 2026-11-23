import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogSection,
  DialogTitle,
} from '@/components/ui/dialog'
import { FormField } from '@/components/ui/form-field'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { toast } from '@/components/ui/toaster'
import {
  createBucket,
  fromBytes,
  nameProblem,
  parseMimeTypes,
  SIZE_UNITS,
  toBytes,
  updateBucket,
  type Bucket,
  type SizeUnit,
} from '@/lib/storage-api'

export const bucketsKey = (ref: string) => ['projects', ref, 'storage', 'buckets'] as const

/** Create a bucket, or change an existing one's access and limits. */
export function BucketDialog({ projectRef, bucket, onClose, onCreated }: { projectRef: string; bucket?: Bucket; onClose: () => void; onCreated?: (name: string) => void }) {
  const queryClient = useQueryClient()
  const initialLimit = bucket?.file_size_limit ? fromBytes(bucket.file_size_limit) : { value: 50, unit: 'MB' as SizeUnit }
  const [name, setName] = useState(bucket?.name ?? '')
  const [isPublic, setPublic] = useState(bucket?.public ?? false)
  const [limitOn, setLimitOn] = useState(!!bucket?.file_size_limit)
  const [limitValue, setLimitValue] = useState(String(initialLimit.value))
  const [limitUnit, setLimitUnit] = useState<SizeUnit>(initialLimit.unit)
  const [typesOn, setTypesOn] = useState(!!bucket?.allowed_mime_types?.length)
  const [types, setTypes] = useState((bucket?.allowed_mime_types ?? []).join(', '))

  const problem = bucket ? null : nameProblem(name, 'bucket')
  const limit = Number(limitValue)
  const limitOk = !limitOn || (Number.isFinite(limit) && limit > 0)
  const typeList = parseMimeTypes(types)
  const typesOk = !typesOn || (typeList.length > 0 && typeList.every((t) => /^[\w.+-]+\/[\w.+*-]+$/.test(t)))

  const save = useMutation<unknown, Error>({
    mutationFn: () => {
      const settings = {
        public: isPublic,
        fileSizeLimit: limitOn ? toBytes(limit, limitUnit) : null,
        allowedMimeTypes: typesOn ? typeList : null,
      }
      return bucket ? updateBucket(projectRef, bucket.id, settings) : createBucket(projectRef, name.trim(), settings)
    },
    onSuccess: async () => {
      toast.success(bucket ? `Updated ${bucket.name}` : `Created ${name.trim()}`)
      await queryClient.invalidateQueries({ queryKey: bucketsKey(projectRef) })
      onClose()
      if (!bucket) onCreated?.(name.trim())
    },
  })

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="medium">
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (!problem && limitOk && typesOk && !save.isPending) save.mutate()
          }}
        >
          <DialogHeader>
            <DialogTitle>{bucket ? `Edit bucket ${bucket.name}` : 'Create a storage bucket'}</DialogTitle>
            <DialogDescription>Buckets hold files. Who may use them is set by Storage policies.</DialogDescription>
          </DialogHeader>
          <DialogSection className="flex flex-col gap-5 border-t">
            {save.error && <Alert variant="destructive" title={save.error.message} />}
            {!bucket && (
              <FormField
                label="Name"
                htmlFor="bucket-name"
                description={problem && name ? <span className="text-destructive">{problem}</span> : "Can't be changed later."}
              >
                <Input id="bucket-name" autoFocus autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} placeholder="avatars" />
              </FormField>
            )}
            <label className="flex items-start gap-3 text-sm">
              <Switch checked={isPublic} onCheckedChange={setPublic} aria-label="Public bucket" />
              <span>
                Public bucket
                <span className="block text-xs text-foreground-lighter">
                  Anyone can read files by URL without signing in. Uploads, changes and deletes still follow your policies.
                </span>
              </span>
            </label>
            {isPublic && !bucket?.public && (
              <Alert variant="warning" title="Everything in this bucket will be readable by anyone with its URL." />
            )}
            <div className="flex flex-col gap-2">
              <label className="flex items-start gap-3 text-sm">
                <Checkbox checked={limitOn} onCheckedChange={(c) => setLimitOn(c === true)} className="mt-0.5" />
                <span>
                  Restrict file size
                  <span className="block text-xs text-foreground-lighter">Otherwise the stack&apos;s own limit (FILE_SIZE_LIMIT) applies.</span>
                </span>
              </label>
              {limitOn && (
                <div className="ml-7 flex gap-2">
                  <Input
                    aria-label="Size limit"
                    inputMode="decimal"
                    className="w-32"
                    value={limitValue}
                    onChange={(e) => setLimitValue(e.target.value)}
                  />
                  <Select value={limitUnit} onValueChange={(v) => setLimitUnit(v as SizeUnit)}>
                    <SelectTrigger className="w-28" aria-label="Size unit">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {SIZE_UNITS.map((u) => (
                        <SelectItem key={u} value={u}>
                          {u}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>
            <div className="flex flex-col gap-2">
              <label className="flex items-start gap-3 text-sm">
                <Checkbox checked={typesOn} onCheckedChange={(c) => setTypesOn(c === true)} className="mt-0.5" />
                <span>
                  Restrict file types
                  <span className="block text-xs text-foreground-lighter">Only these MIME types can be uploaded.</span>
                </span>
              </label>
              {typesOn && (
                <div className="ml-7">
                  <FormField
                    label="Allowed MIME types"
                    htmlFor="bucket-types"
                    description={!typesOk && types ? <span className="text-destructive">Use types like image/png or image/*, separated by commas.</span> : 'e.g. image/*, application/pdf'}
                  >
                    <Input id="bucket-types" value={types} onChange={(e) => setTypes(e.target.value)} placeholder="image/*, application/pdf" />
                  </FormField>
                </div>
              )}
            </div>
          </DialogSection>
          <DialogFooter>
            <Button type="button" variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={!!problem || !limitOk || !typesOk} loading={save.isPending}>
              {bucket ? 'Save' : 'Create bucket'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
