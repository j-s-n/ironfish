/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import * as yup from 'yup'
import { ApiNamespace } from '../../namespaces'
import { routes } from '../../router'
import { AssertHasRpcContext } from '../../rpcContext'

export type CreateParticipantRequest = {
  name: string
}

export type CreateParticipantResponse = {
  identity: string
}

export const CreateParticipantRequestSchema: yup.ObjectSchema<CreateParticipantRequest> = yup
  .object({
    name: yup.string().defined(),
  })
  .defined()

export const CreateParticipantResponseSchema: yup.ObjectSchema<CreateParticipantResponse> = yup
  .object({
    identity: yup.string().defined(),
  })
  .defined()

routes.register<typeof CreateParticipantRequestSchema, CreateParticipantResponse>(
  `${ApiNamespace.wallet}/multisig/createParticipant`,
  CreateParticipantRequestSchema,
  async (request, context): Promise<void> => {
    AssertHasRpcContext(request, context, 'wallet')

    const identity = await context.wallet.createMultisigSecret(request.data.name)
    request.end({ identity: identity.toString('hex') })
  },
)
