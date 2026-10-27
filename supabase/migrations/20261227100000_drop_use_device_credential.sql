-- Drops use_device_credential (architecture review). Since share-ingest it has only been a wrapper
-- around authenticate_device_credential, and nothing calls it: verifyDeviceCredential calls
-- authenticate_device_credential, which also answers the credential's id.

drop function public.use_device_credential(text, text);
