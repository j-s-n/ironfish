/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { RPC_ERROR_CODES, RpcRequestError } from '@ironfish/sdk'
import { Flags } from '@oclif/core'
import { IronfishCommand } from '../../../../command'
import { RemoteFlags } from '../../../../flags'
import { inputPrompt } from '../../../../ui'

export class MultisigIdentityCreate extends IronfishCommand {
  static description = `Create a multisig participant identity`

  static flags = {
    ...RemoteFlags,
    name: Flags.string({
      char: 'n',
      description: 'Name to associate with the identity',
    }),
  }

  async start(): Promise<void> {
    const { flags } = await this.parse(MultisigIdentityCreate)
    let name = flags.name
    if (!name) {
      name = await inputPrompt('Enter a name for the identity', true)
    }

    const client = await this.connectRpc()
    let response
    while (!response) {
      try {
        response = await client.wallet.multisig.createParticipant({ name })
      } catch (e) {
        if (
          e instanceof RpcRequestError &&
          e.code === RPC_ERROR_CODES.DUPLICATE_ACCOUNT_NAME.toString()
        ) {
          this.log()
          this.log(e.codeMessage)
          name = await inputPrompt('Enter a new name for the identity', true)
        } else {
          throw e
        }
      }
    }

    this.log('Identity:')
    this.log(response.content.identity)
  }
}
