# Changelog

## 0.2.0 (23 Nov 2026)

- Updated the bundled OpenAPI document to Prefect 3.9.4. The deployment run endpoint now documents 200 for an existing run, 201 for a new run, and 400, 404 and 409 for errors. Updating a deployment now documents 400, 404 and 409 for errors.
- Documented those responses in the client and added a unit test that checks `ConflictError` preserves the deployment run's 409 detail.
