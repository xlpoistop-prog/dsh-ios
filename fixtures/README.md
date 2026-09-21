# Test fixtures

Two PNGs and a verification script. Nothing here is needed to *run* DSH — these
exist so that the pure-JS image codec can be checked against recorded truth
rather than against itself.

```sh
# after install.sh, from the repo root
node --jitless fixtures/verify-image-codec.mjs
# or point it at the installed codec
node --jitless fixtures/verify-image-codec.mjs /path/to/dsh/node_modules/sharp/dist/ios
```

## Why recorded truth, and not just "it decoded"

An earlier version of this codec encoded JPEGs with an `SOF0` segment length of
**19** where the specification requires `8 + 3 × components` = **17**, leaving two
bytes of uninitialised heap in the gap. Every self-test passed, because our own
decoder ignored the length field. The API rejected the files immediately.

So `verify-image-codec.mjs` does two things a naive round-trip test does not:

1. **walks the JPEG marker segments and checks the SOF0 length against the
   component count**, rather than only asking whether the result decodes;
2. **samples specific pixels and compares them to colours recorded in advance**
   in `blind-test.answer.txt`.

## `test-image.png` — 480×200 RGBA

| Where | Content |
|---|---|
| top-left | `DSH-7742`, gold, bold, 36 pt |
| below it | `purple triangle below`, white, 20 pt |
| lower centre | a purple triangle, apex up |
| background | dark navy |

Used to check metadata, PNG losslessness, JPEG structure, and resizing. The
caption is deliberately redundant with the drawing: a reader that only gets the
text, or only gets the shape, is still visibly incomplete.

## `blind-test.png` — 400×240 RGBA

| Where | Content |
|---|---|
| top-left | `SV-6477`, black, bold |
| lower centre | a filled circle, DodgerBlue |
| background | light green |

**`blind-test.answer.txt` records the truth:**

```
label=SV-6477 shape=circle shapeColor=DodgerBlue bg=ffc8e6c8
```

This image was generated with randomised content and **never described to the
model** before being submitted. It is the fixture that produced the useful
result: asked to read it, the model returned `SV-6477`, "a circle", "blue", and
"light green" — the exact string, the right shape, and both colours.

**Why colour is the load-bearing evidence.** An earlier, provisional approach
had the agent decode the PNG by hand and render it as a character grid. That
works for shapes and cannot carry colour at all. When the codec was in place and
the model reported colours correctly, two things were established at once: the
pixels were genuinely decoded, and they reached the model as an image rather
than as text.

If you are adapting this port, **regenerate a fixture like this one** before
trusting any change to the image path. Randomised content, truth written down
first, no hints given to the model. It takes a minute and it is the difference
between "it works" and "it printed something".

## Regenerating

`blind-test.png` was made with `System.Drawing` (PowerShell on Windows):

```powershell
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap 400,240
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = 'AntiAlias'
$g.Clear([System.Drawing.Color]::FromArgb(200,230,200))         # light green
$g.DrawString('SV-6477', (New-Object System.Drawing.Font('Arial',40,[System.Drawing.FontStyle]::Bold)),
              [System.Drawing.Brushes]::Black, 20, 20)
$g.FillEllipse((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::DodgerBlue)), 150,110,100,100)
$g.Dispose(); $bmp.Save("$PWD/blind-test.png", [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
```

Change the string, the shape and the colours, write down what you used, and
resist describing it to the model.
