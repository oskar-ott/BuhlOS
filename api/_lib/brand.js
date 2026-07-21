// CommonJS mirror of src/naming/brand.ts for the legacy API layer (emails).
// Keep the values in sync — deprecated-naming.test.ts asserts it.
//
// This version ships as ONE brand: every surface presents as **BuhlOS**.
// "Phil" is reserved as a possible future field-app brand; routes and code
// identifiers keep the phil name (field URLs are sacred — never rename them).

const FIELD_APP_NAME = 'BuhlOS';
const OFFICE_APP_NAME = 'BuhlOS';

module.exports = { FIELD_APP_NAME, OFFICE_APP_NAME };
