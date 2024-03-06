/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use ironfish_frost::participant::Identity;
use ironfish_frost::{
    frost::{
        frost::keys::split,
        keys::{IdentifierList, KeyPackage},
        SigningKey,
    },
    keys::PublicKeyPackage,
};
use rand::{CryptoRng, RngCore};
use std::collections::HashMap;

use crate::errors::IronfishError;
use crate::SaplingKey;

pub struct SecretShareConfig {
    pub min_signers: u16,
    pub identities: Vec<Identity>,
    pub spender_key: SaplingKey,
}

pub(crate) fn split_secret<R: RngCore + CryptoRng>(
    config: &SecretShareConfig,
    mut rng: R,
) -> Result<(HashMap<Identity, KeyPackage>, PublicKeyPackage), IronfishError> {
    let mut frost_id_map = config
        .identities
        .iter()
        .cloned()
        .map(|identity| (identity.to_frost_identifier(), identity))
        .collect::<HashMap<_, _>>();
    let frost_ids = frost_id_map.keys().cloned().collect::<Vec<_>>();
    let identifier_list = IdentifierList::Custom(&frost_ids[..]);

    let secret_key = SigningKey::deserialize(config.spender_key.spend_authorizing_key.to_bytes())?;
    let max_signers: u16 = config.identities.len().try_into()?;

    let (shares, pubkeys) = split(
        &secret_key,
        max_signers,
        config.min_signers,
        identifier_list,
        &mut rng,
    )?;

    let mut key_packages: HashMap<_, _> = HashMap::new();

    for (frost_id, secret_share) in shares {
        let identity = frost_id_map
            .remove(&frost_id)
            .expect("frost returned an identifier that was not passed as an input");
        let key_package = KeyPackage::try_from(secret_share.clone())?;
        key_packages.insert(identity, key_package);
    }

    let public_key_package =
        PublicKeyPackage::from_frost(pubkeys, config.identities.iter().cloned());

    Ok((key_packages, public_key_package))
}

#[cfg(test)]
mod test {
    use super::*;
    use crate::{keys::SaplingKey, test_util::create_multisig_identities};
    use ironfish_frost::frost::{frost::keys::reconstruct, JubjubBlake2b512};

    #[test]
    fn test_split_secret() {
        let identities = create_multisig_identities(10);
        let identities_length = identities.len();

        let rng = rand::thread_rng();
        let key = SaplingKey::generate_key();

        let config = SecretShareConfig {
            min_signers: 2,
            identities,
            spender_key: key,
        };

        let (key_packages, _) = split_secret(&config, rng).unwrap();
        assert_eq!(key_packages.len(), identities_length);

        let key_parts: Vec<_> = key_packages.values().cloned().collect();

        let signing_key =
            reconstruct::<JubjubBlake2b512>(&key_parts).expect("key reconstruction failed");

        let scalar = signing_key.to_scalar();

        assert_eq!(
            scalar.to_bytes(),
            config.spender_key.spend_authorizing_key.to_bytes()
        );
    }
}
