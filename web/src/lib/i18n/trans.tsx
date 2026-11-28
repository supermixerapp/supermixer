/*
 * A sentence with markup inside: <Trans i18nKey="ns:key" components={{ link:
 * <Link …/> }} />, where the text has <link>…</link> (or <link/> for an
 * element shown as is). Keys are checked like t()'s.
 */
import type { ParseKeys } from 'i18next'
import type { ReactElement } from 'react'
import { Trans as BaseTrans } from 'react-i18next'

import type { Namespace } from './resources.gen'

export function Trans({
  i18nKey,
  values,
  components,
}: {
  i18nKey: ParseKeys<Namespace[]>
  values?: Record<string, unknown>
  components?: Record<string, ReactElement>
}) {
  // react-i18next's own key types don't take "ns:key" with many namespaces.
  return <BaseTrans i18nKey={i18nKey as never} values={values} components={components} />
}
