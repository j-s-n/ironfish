/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { createSignatureShare, UnsignedTransaction } from '@ironfish/rust-nodejs'
import * as yup from 'yup'
import { AssertMultisigSigner } from '../../../../wallet'
import { ApiNamespace } from '../../namespaces'
import { routes } from '../../router'
import { AssertHasRpcContext } from '../../rpcContext'
import { getAccount } from '../utils'

export type CreateSignatureShareRequest = {
  account?: string
  signingPackage: string
  unsignedTransaction: string // TODO make `unsignedTransaction` part of `signingPackage`
  signers: Array<{ identity: string }> // TODO make `signers` part of `signingPackage`
}

export type CreateSignatureShareResponse = {
  signatureShare: string
}

export const CreateSignatureShareRequestSchema: yup.ObjectSchema<CreateSignatureShareRequest> =
  yup
    .object({
      account: yup.string().optional(),
      signingPackage: yup.string().defined(),
      unsignedTransaction: yup.string().defined(),
      signers: yup
        .array(
          yup
            .object({
              identity: yup.string().defined(),
            })
            .defined(),
        )
        .defined(),
    })
    .defined()

export const CreateSignatureShareResponseSchema: yup.ObjectSchema<CreateSignatureShareResponse> =
  yup
    .object({
      signatureShare: yup.string().defined(),
    })
    .defined()

routes.register<typeof CreateSignatureShareRequestSchema, CreateSignatureShareResponse>(
  `${ApiNamespace.wallet}/multisig/createSignatureShare`,
  CreateSignatureShareRequestSchema,
  (request, node): void => {
    AssertHasRpcContext(request, node, 'wallet')

    const account = getAccount(node.wallet, request.data.account)
    AssertMultisigSigner(account)

    const unsigned = new UnsignedTransaction(
      Buffer.from(request.data.unsignedTransaction, 'hex'),
    )
    const signatureShare = createSignatureShare(
      account.multisigKeys.identity,
      account.multisigKeys.keyPackage,
      request.data.signingPackage,
      unsigned.hash(),
      unsigned.publicKeyRandomness(),
      request.data.signers.map((signer) => signer.identity),
    )

    request.end({ signatureShare })
  },
)
