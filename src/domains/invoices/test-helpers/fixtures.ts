/**
 * Clearly FAKE supplier documents as extracted-text fixtures. No real
 * wholesaler, ABN, address or amount appears here (the ABN is the ATO's
 * published example). Real supplier samples are still required to validate
 * extraction against actual layouts — docs/invoice-capture.md.
 */

export const TAX_INVOICE_IV0041 = `Sparky Supplies Pty Ltd
ABN 51 824 753 556
12 Example Street, Faketown NSW 2000
TAX INVOICE
Tax Invoice No: SS-88123
Invoice Date: 03/09/2026
Account: BUHL01
Job Number: IV 0041
Your Reference: Birdwood level 2
Bill To: Buhl Electrical
Qty   Description                          Unit      Total
10    2.5mm TPS cable 100m                 84.00     840.00
2     Switchboard enclosure                120.00    240.00
                                           Sub Total 1,080.00
                                           GST       108.00
                                           Total (inc GST) 1,188.00
Payment due 30 days`;

export const CREDIT_NOTE_IV0041 = `Sparky Supplies Pty Ltd
ABN 51 824 753 556
CREDIT NOTE
Credit Note No: CN-2001
Date: 05/09/2026
Original invoice: SS-88123
Order Number: IV0041
Returned: 1 x Switchboard enclosure
                                           Sub Total 120.00
                                           GST       12.00
                                           Total     132.00`;

export const STATEMENT = `Sparky Supplies Pty Ltd
STATEMENT OF ACCOUNT
Account: BUHL01
Statement Date: 30/09/2026
Invoice SS-88123  03/09/2026  1,188.00
Invoice SS-88200  17/09/2026  350.00
Balance Due 1,538.00`;

export const QUOTE = `Wholesale Wires Pty Ltd
QUOTATION
Quote No: Q-500
Date: 01/09/2026
Job Reference: IV0042
Cable and accessories as discussed
                                           Sub Total 2,000.00
                                           GST       200.00
                                           Total     2,200.00`;

export const INVOICE_NO_REFERENCE = `Wholesale Wires Pty Ltd
TAX INVOICE
Invoice No: WW-1
Invoice Date: 10/09/2026
Sub Total 100.00
GST 10.00
Total 110.00`;

export const INVOICE_MULTI_REFERENCE = `Wholesale Wires Pty Ltd
TAX INVOICE
Invoice No: WW-2
Invoice Date: 10/09/2026
Job Number: IV0041
Order Number: IV0042
Sub Total 100.00
GST 10.00
Total 110.00`;

export const INVOICE_GST_INCONSISTENT = `Wholesale Wires Pty Ltd
TAX INVOICE
Invoice No: WW-3
Invoice Date: 10/09/2026
Job Number: IV0041
Sub Total 100.00
GST 10.00
Total 121.00`;

export const INVOICE_MISSING_SUBTOTAL = `Wholesale Wires Pty Ltd
TAX INVOICE
Invoice No: WW-4
Invoice Date: 10/09/2026
Job Number: IV0041
Total 110.00`;

export const INVOICE_TWO_OF_THREE = `Wholesale Wires Pty Ltd
TAX INVOICE
Invoice No: WW-5
Invoice Date: 10 Sep 2026
Customer Ref: IV-0041
Total ex GST 200.00
Total inc GST 220.00`;

export const INVOICE_UNKNOWN_IV = `Wholesale Wires Pty Ltd
TAX INVOICE
Invoice No: WW-6
Invoice Date: 10/09/2026
Job Number: IV0999
Sub Total 50.00
GST 5.00
Total 55.00`;

export const INVOICE_MALFORMED_REF = `Wholesale Wires Pty Ltd
TAX INVOICE
Invoice No: WW-7
Invoice Date: 10/09/2026
Job Number: IV41
Sub Total 50.00
GST 5.00
Total 55.00`;

export const JOBS = [
  { id: "birdwood", name: "Birdwood", code: "IV0041", status: "active" },
  { id: "kent-st", name: "Kent St fit-out", code: "IV0042", status: "complete" },
  { id: "old-job", name: "Old job", code: "IV0050", status: "archived" },
  { id: "no-code", name: "No code yet" },
  { id: "deleted", name: "Deleted", code: "IV0043", deleted: true },
];
