# Changelog

## 0.2.1 (25 Nov 2026)

- PrefectHQ/prefect#23880 (merged 25 Nov) documents the 422 bodies the server really sends: `InvalidRequestResponse`, `HTTPErrorResponse` and `TemplateValidationErrorResponse`. The client now exports matching types.
- `ValidationError` reads the template validation shape `{"error": {"line", "message", "source"}}` and puts the line and message in the error text.
- `ValidationError.requestBody` holds the request body the server echoed back in a validation error.
- The bundled OpenAPI document stays at Prefect 3.9.4 until a release ships the new schema.

## 0.2.0 (23 Nov 2026)

- Updated the bundled OpenAPI document to Prefect 3.9.4. The deployment run endpoint now documents 200 for an existing run, 201 for a new run, and 400, 404 and 409 for errors. Updating a deployment now documents 400, 404 and 409 for errors.
- Documented those responses in the client and added a unit test that checks `ConflictError` preserves the deployment run's 409 detail.
