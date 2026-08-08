# providers/

External provider adapters behind interfaces (TECHNICAL_CANON.md §23):

- VideoGenerationProvider (Kling / mock)
- TTSProvider
- ObjectStorageProvider
- PaymentProvider (Paystack / PayPal / Stripe / Crypto)
- EmailProvider
- AISelectionProvider

Empty at the foundation stage. Per canon §36–§37, mock implementations
come first; no provider may be hardcoded throughout the application, and
no paid API calls are made during development.
