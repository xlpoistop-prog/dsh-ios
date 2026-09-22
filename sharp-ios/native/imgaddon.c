/* imgaddon — native image decode for DSH's pure-JS sharp backend.
 * Isolated: nothing here touches the running DSH process.
 *
 * stb_image_resize2 is deliberately not used, and its header is not vendored
 * here. The resampler below is a bit-exact port of the JS one: any other kernel,
 * stb's included, shifts edges and visibly changes the image, which is not an
 * acceptable trade on a path that is supposed to be lossless. See resample_axis.
 *
 * stb_image and stb_image_write are vendored in ./stb — public domain, see
 * ../../../THIRD_PARTY_NOTICES.md for the versions. */
#include <node_api.h>
#include <stdlib.h>
#include <math.h>
#include <string.h>
#define STB_IMAGE_IMPLEMENTATION
#include "stb/stb_image.h"
#define STB_IMAGE_WRITE_IMPLEMENTATION
#include "stb/stb_image_write.h"

static napi_value Decode(napi_env env, napi_callback_info info) {
    size_t argc = 1; napi_value argv[1];
    napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
    bool isbuf = false;
    if (argc < 1 || napi_is_buffer(env, argv[0], &isbuf) != napi_ok || !isbuf) {
        napi_throw_type_error(env, NULL, "decode(buffer): expected a Buffer");
        return NULL;
    }
    void *src = NULL; size_t len = 0;
    napi_get_buffer_info(env, argv[0], &src, &len);
    int w = 0, h = 0, comp = 0;
    /* always hand back 4 channels: that is what sharp's raw path expects */
    unsigned char *px = stbi_load_from_memory((const stbi_uc *)src, (int)len, &w, &h, &comp, 4);
    if (!px) { napi_throw_error(env, NULL, stbi_failure_reason()); return NULL; }
    napi_value out, v, buf; void *dst = NULL;
    napi_create_object(env, &out);
    napi_create_int32(env, w, &v);    napi_set_named_property(env, out, "width", v);
    napi_create_int32(env, h, &v);    napi_set_named_property(env, out, "height", v);
    napi_create_int32(env, comp, &v); napi_set_named_property(env, out, "sourceChannels", v);
    napi_create_buffer_copy(env, (size_t)w * (size_t)h * 4, px, &dst, &buf);
    napi_set_named_property(env, out, "data", buf);
    stbi_image_free(px);
    return out;
}

static napi_value Info(napi_env env, napi_callback_info info) {
    size_t argc = 1; napi_value argv[1];
    napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
    void *src = NULL; size_t len = 0;
    if (argc < 1 || napi_get_buffer_info(env, argv[0], &src, &len) != napi_ok) return NULL;
    int w = 0, h = 0, comp = 0;
    if (!stbi_info_from_memory((const stbi_uc *)src, (int)len, &w, &h, &comp)) {
        napi_throw_error(env, NULL, stbi_failure_reason()); return NULL;
    }
    napi_value out, v;
    napi_create_object(env, &out);
    napi_create_int32(env, w, &v);    napi_set_named_property(env, out, "width", v);
    napi_create_int32(env, h, &v);    napi_set_named_property(env, out, "height", v);
    napi_create_int32(env, comp, &v); napi_set_named_property(env, out, "channels", v);
    return out;
}


/* PNG encode. Returns a Buffer; the caller compares pixels, not bytes — two
   encoders legitimately choose different filters/compression. */
static napi_value EncodePng(napi_env env, napi_callback_info info) {
    size_t argc = 5; napi_value argv[5];
    napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
    void *px = NULL; size_t len = 0;
    int w = 0, h = 0, inCh = 4, outCh = 4;
    if (argc < 3 || napi_get_buffer_info(env, argv[0], &px, &len) != napi_ok) {
        napi_throw_type_error(env, NULL, "encodePng(buffer, width, height[, inChannels[, outChannels]])"); return NULL;
    }
    napi_get_value_int32(env, argv[1], &w);
    napi_get_value_int32(env, argv[2], &h);
    if (argc > 3) napi_get_value_int32(env, argv[3], &inCh);
    if (argc > 4) napi_get_value_int32(env, argv[4], &outCh);
    if (w <= 0 || h <= 0 || inCh < 1 || inCh > 4 || outCh < 1 || outCh > 4 || len < (size_t)w * h * inCh) {
        napi_throw_error(env, NULL, "encodePng: size mismatch"); return NULL;
    }
    /* stb writes exactly `n` channels from the source, so dropping alpha needs a
       compacted copy first (the JS encoder emits 3 channels for opaque images). */
    const unsigned char *src = (const unsigned char *)px;
    unsigned char *tmp = NULL;
    if (outCh != inCh) {
        tmp = (unsigned char *)malloc((size_t)w * h * outCh);
        if (!tmp) { napi_throw_error(env, NULL, "encodePng: alloc failed"); return NULL; }
        for (size_t i = 0, n = (size_t)w * h; i < n; i++)
            for (int c = 0; c < outCh; c++) tmp[i * outCh + c] = src[i * inCh + c];
        src = tmp;
    }
    int outLen = 0;
    unsigned char *png = stbi_write_png_to_mem(src, w * outCh, w, h, outCh, &outLen);
    if (tmp) free(tmp);
    if (!png) { napi_throw_error(env, NULL, "encodePng failed"); return NULL; }
    napi_value buf; void *dst = NULL;
    napi_create_buffer_copy(env, (size_t)outLen, png, &dst, &buf);
    STBIW_FREE(png);
    return buf;
}


/* Bit-exact C port of resize.cjs. Matching the JS resampler matters: any other
   kernel shifts edges and visibly changes the image, which is why stb's filters
   were rejected. Separable: exact box average when downscaling, centre-mapped
   bilinear when upscaling, Math.round semantics (floor(v + 0.5)) on 8-bit data. */
static void resample_axis(const unsigned char *src, int n, int m, int ch, int outN,
                          int axis, unsigned char *out) {
    if (outN == n) { memcpy(out, src, (size_t)n * m * ch); return; }
    const double scale = (double)n / outN;
    for (int j = 0; j < m; j++) {
        for (int i = 0; i < outN; i++) {
            const size_t d = (axis == 0) ? ((size_t)j * outN + i) * ch : ((size_t)i * m + j) * ch;
            if (outN < n) {
                const double start = i * scale, end = start + scale;
                int x0 = (int)floor(start), x1 = (int)ceil(end);
                if (x1 > n) x1 = n;
                if (x0 > n - 1) x0 = n - 1;
                double acc[4] = {0, 0, 0, 0}, total = 0;
                for (int x = x0; x < x1; x++) {
                    const double w = fmin(end, x + 1.0) - fmax(start, (double)x);
                    if (w <= 0) continue;
                    total += w;
                    const size_t p = (axis == 0) ? ((size_t)j * n + x) * ch : ((size_t)x * m + j) * ch;
                    for (int c = 0; c < ch; c++) acc[c] += src[p + c] * w;
                }
                if (total <= 0) {
                    int xs = (int)floor(start);
                    if (xs < 0) xs = 0;
                    if (xs > n - 1) xs = n - 1;
                    const size_t p = (axis == 0) ? ((size_t)j * n + xs) * ch : ((size_t)xs * m + j) * ch;
                    for (int c = 0; c < ch; c++) out[d + c] = src[p + c];
                } else {
                    for (int c = 0; c < ch; c++) out[d + c] = (unsigned char)floor(acc[c] / total + 0.5);
                }
            } else {
                const double center = (i + 0.5) * scale - 0.5;
                int x0 = (int)floor(center);
                double f = center - x0;
                if (x0 < 0) { x0 = 0; f = 0; }
                int x1 = x0 + 1;
                if (x1 > n - 1) x1 = n - 1;
                if (x0 > n - 1) { x0 = n - 1; x1 = n - 1; f = 0; }
                const size_t p0 = (axis == 0) ? ((size_t)j * n + x0) * ch : ((size_t)x0 * m + j) * ch;
                const size_t p1 = (axis == 0) ? ((size_t)j * n + x1) * ch : ((size_t)x1 * m + j) * ch;
                const double g = 1 - f;
                for (int c = 0; c < ch; c++)
                    out[d + c] = (unsigned char)floor(src[p0 + c] * g + src[p1 + c] * f + 0.5);
            }
        }
    }
}

/* Resize using the ported algorithm. */
static napi_value Resize(napi_env env, napi_callback_info info) {
    size_t argc = 6; napi_value argv[6];
    napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
    void *px = NULL; size_t len = 0;
    int w = 0, h = 0, nw = 0, nh = 0, ch = 4;
    if (argc < 5 || napi_get_buffer_info(env, argv[0], &px, &len) != napi_ok) {
        napi_throw_type_error(env, NULL, "resize(buffer, width, height, newWidth, newHeight[, channels])"); return NULL;
    }
    napi_get_value_int32(env, argv[1], &w);  napi_get_value_int32(env, argv[2], &h);
    napi_get_value_int32(env, argv[3], &nw); napi_get_value_int32(env, argv[4], &nh);
    if (argc > 5) napi_get_value_int32(env, argv[5], &ch);
    if (w <= 0 || h <= 0 || nw <= 0 || nh <= 0 || ch < 1 || ch > 4 || len < (size_t)w * h * ch) {
        napi_throw_error(env, NULL, "resize: size mismatch"); return NULL;
    }
    napi_value buf; void *dst = NULL;
    unsigned char *out = napi_create_buffer(env, (size_t)nw * nh * ch, &dst, &buf) == napi_ok ? (unsigned char *)dst : NULL;
    if (!out) { napi_throw_error(env, NULL, "resize: alloc failed"); return NULL; }
    unsigned char *tmp = (unsigned char *)malloc((size_t)nw * h * ch);
    if (!tmp) { napi_throw_error(env, NULL, "resize: alloc failed"); return NULL; }
    resample_axis((const unsigned char *)px, w, h, ch, nw, 0, tmp);
    resample_axis(tmp, h, nw, ch, nh, 1, out);
    free(tmp);
    return buf;
}

static napi_value Init(napi_env env, napi_value exports) {
    napi_value fn;
    napi_create_function(env, NULL, 0, Decode, NULL, &fn);
    napi_set_named_property(env, exports, "decode", fn);
    napi_create_function(env, NULL, 0, Info, NULL, &fn);
    napi_set_named_property(env, exports, "info", fn);
    napi_create_function(env, NULL, 0, EncodePng, NULL, &fn);
    napi_set_named_property(env, exports, "encodePng", fn);
    napi_create_function(env, NULL, 0, Resize, NULL, &fn);
    napi_set_named_property(env, exports, "resize", fn);
    return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
