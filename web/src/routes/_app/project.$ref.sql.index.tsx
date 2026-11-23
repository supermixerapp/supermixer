import { createFileRoute, redirect } from '@tanstack/react-router'

export const Route = createFileRoute('/_app/project/$ref/sql/')({
  beforeLoad: ({ params }) => {
    throw redirect({ to: '/project/$ref/sql/$id', params: { ref: params.ref, id: 'new' }, replace: true })
  },
})
