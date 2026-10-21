import type { ReactElement } from 'react';

/**
 * The product marks used inside the drawer. These are the apps' own marks, not
 * generic glyphs — the same shapes they use in their headers and icons, reduced
 * to a square tile.
 *
 * Colour notes:
 * - `currentColor` is the product ink from the registry (via the tile).
 * - Fixed fills are the parts that are part of the mark itself (Calendar red,
 *   Drive gradient, Mail envelope).
 */
export const APP_MARKS: Record<string, ReactElement> = {
  forms: (
    <svg viewBox="0 0 32 32" aria-hidden="true">
      <rect x="6" y="4" width="20" height="24" rx="3" fill="none" stroke="currentColor" strokeWidth="1.7" />
      <path d="M11 10h10M11 14h10" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <g stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <line x1="16" y1="17" x2="16" y2="24" />
        <line x1="12.9" y1="18.8" x2="19.1" y2="22.2" />
        <line x1="19.1" y1="18.8" x2="12.9" y2="22.2" />
      </g>
    </svg>
  ),

  calendar: (
    <svg viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="7" fill="#111111" />
      <path d="M0 7a7 7 0 0 1 7-7h18a7 7 0 0 1 7 7v3H0z" fill="#E24B4A" />
      <text
        x="16"
        y="5.6"
        textAnchor="middle"
        dominantBaseline="middle"
        fill="rgba(255,255,255,0.88)"
        fontSize="5"
        fontWeight="800"
        fontFamily="inherit"
      >
        JAN
      </text>
      <text
        x="16"
        y="22"
        textAnchor="middle"
        dominantBaseline="middle"
        fill="#FFFFFF"
        fontSize="14"
        fontWeight="800"
        fontFamily="inherit"
      >
        3
      </text>
    </svg>
  ),

  pages: (
    <svg viewBox="-48 -56 624 624" aria-hidden="true">
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M154 421C156 420 174 389 176 385C177 383 178 380 179 379C180 377 181 375 182 374C183 373 183 372 184 371C185 370 187 366 188 363C190 360 192 356 193 355C194 354 194 353 195 352C196 351 197 349 198 347C199 346 200 344 200 343C200 342 201 341 202 339C203 338 206 331 210 324C214 316 217 309 218 308C219 307 221 302 223 297C230 284 229 285 238 287C243 289 247 290 254 291C256 291 259 291 261 292C265 292 282 292 285 292C286 291 289 291 290 291C301 290 321 283 332 277C334 276 336 275 337 274C339 273 348 266 350 264C351 263 352 262 353 262C355 261 363 252 365 250C365 250 367 248 368 246C369 245 371 242 373 240C374 238 376 236 376 236C385 224 397 192 397 180C397 179 397 178 398 176C398 174 398 172 398 166C398 159 398 157 398 155C397 153 397 152 397 151C397 147 393 130 390 124C389 122 388 120 388 119C384 110 377 99 370 91C363 84 363 84 355 78C349 73 338 66 331 63C329 62 327 62 326 61C322 59 310 56 306 55C304 55 300 54 295 53C291 53 277 53 273 53C265 55 262 54 262 49C262 48 262 45 261 44C261 43 261 40 261 34C261 20 259 20 250 35C250 36 247 40 245 44C243 47 239 53 237 57C232 64 231 65 228 67C224 69 215 75 213 77C212 78 210 79 210 79C208 81 197 92 196 93C195 94 194 95 193 97C190 101 189 106 188 111C187 115 187 116 188 119C188 120 188 122 188 123C189 126 192 133 195 137C198 141 198 141 195 148C194 150 193 154 192 155C192 156 191 159 190 162C189 164 188 167 187 169C187 170 185 174 184 176C183 180 180 188 178 194C177 196 176 199 175 201C174 204 173 206 171 209C164 216 158 231 157 240C157 242 156 246 155 252C155 254 155 256 155 257C155 258 155 260 154 262C154 264 154 266 154 268C154 269 154 271 154 273C153 275 153 277 153 280C153 283 153 285 152 287C152 289 152 291 152 297C152 303 152 305 152 307C151 310 151 311 151 346C151 382 151 383 150 386C150 390 150 398 150 401C151 403 151 406 151 412C151 423 152 424 154 421ZM174 356C172 355 169 348 169 343C169 342 169 340 168 338C168 334 168 333 170 329C171 327 171 326 172 322C173 319 174 316 174 314C174 313 175 310 176 307C177 304 178 301 178 300C178 298 179 296 179 295C181 289 183 287 187 287C192 287 195 292 193 298C193 299 192 302 191 305C190 308 189 311 189 312C187 320 185 329 185 331C185 332 185 334 185 335C184 336 184 339 184 340C183 351 178 358 174 356ZM264 222C246 220 243 218 245 208C247 200 248 192 249 188C249 186 249 183 250 182C251 176 251 173 251 170C252 167 252 165 254 156C254 154 254 151 255 149C255 147 255 146 255 145C255 144 255 143 256 141C256 139 256 138 256 137C256 131 259 128 266 125C297 114 328 134 329 165C330 199 298 228 264 222Z"
      />
      <rect x="53" y="444" width="422" height="46" rx="23" fill="currentColor" opacity="0.55" />
      <g transform="translate(522 467)" stroke="currentColor" strokeWidth="16" strokeLinecap="round">
        <line x1="0" y1="-36" x2="0" y2="36" />
        <line x1="-31" y1="-18" x2="31" y2="18" />
        <line x1="31" y1="-18" x2="-31" y2="18" />
      </g>
    </svg>
  ),

  drive: (
    <svg viewBox="0 0 96 96" aria-hidden="true">
      <rect width="96" height="96" rx="20" fill="#0B0B0C" />
      <g transform="translate(4,2) scale(0.88)">
        <g transform="rotate(-24 50 78)">
          <rect x="34" y="18" width="32" height="46" rx="4" fill="#7A2629" />
          <path d="M40 26H60M40 34H60M40 42H52" stroke="#B83A3F" strokeWidth="3" strokeLinecap="round" fill="none" />
        </g>
        <g transform="rotate(24 50 78)">
          <rect x="34" y="18" width="32" height="46" rx="4" fill="#B83A3F" />
          <path d="M40 26H60M40 34H60M40 42H52" stroke="#E5484D" strokeWidth="3" strokeLinecap="round" fill="none" />
        </g>
        <rect x="34" y="14" width="32" height="46" rx="4" fill="#E5484D" />
        <path
          d="M50 21V33M44.8 24L55.2 30M55.2 24L44.8 30"
          stroke="#F4F4F3"
          strokeWidth="3.2"
          strokeLinecap="round"
          fill="none"
        />
        <path d="M40 40H60" stroke="#F4F4F3" strokeWidth="3" strokeLinecap="round" fill="none" />
        <rect x="14" y="48" width="72" height="42" rx="8" fill="#F4F4F3" />
      </g>
    </svg>
  ),

  mail: (
    <svg viewBox="23 15.25 68 68" aria-hidden="true">
      <rect x="32" y="40" width="44" height="34" rx="6" fill="#E5484D" />
      <path d="M38.5,44 L54,59 L69.5,44" fill="none" stroke="#F4F4F3" strokeWidth="3.6" strokeLinecap="round" strokeLinejoin="round" />
      <g stroke="var(--fs-desk-ink, #161a18)" strokeWidth="5" strokeLinecap="round">
        <line x1="70" y1="27" x2="70" y2="49" />
        <line x1="60.47" y1="32.5" x2="79.53" y2="43.5" />
        <line x1="79.53" y1="32.5" x2="60.47" y2="43.5" />
      </g>
    </svg>
  ),

  pollerama: (
    <svg viewBox="0 0 140 98" aria-hidden="true">
      <path
        d="M22.4236 7.33331H88.083C93.4046 7.33331 98.709 9.95954 100.13 15.0878C101.709 20.782 101.126 26.0778 99.8354 30.2072C98.4366 34.6824 93.9122 36.9928 89.2286 37.2111C62.6644 38.449 19.1398 39.7074 11.7941 36.8452C6.27402 34.6943 6.72579 25.6851 8.63951 17.4744C10.0956 11.2272 16.0091 7.33331 22.4236 7.33331Z"
        fill="currentColor"
        fillOpacity="0.38"
        stroke="currentColor"
        strokeWidth="13.75"
      />
      <path
        d="M22.7133 59.4166H119.19C123.757 59.4166 128.382 61.283 130.326 65.4154C133.674 72.5329 132.333 79.1629 129.943 83.8624C128.134 87.4204 124.173 89.0182 120.184 89.1638C85.2582 90.4385 23.4205 91.8916 13.281 88.9285C5.47425 86.6471 6.62573 76.6497 9.55968 68.0733C11.4373 62.5849 16.9126 59.4166 22.7133 59.4166Z"
        fill="currentColor"
        stroke="currentColor"
        strokeWidth="13.75"
      />
    </svg>
  ),

  nips: (
    <svg viewBox="0 0 32 32" aria-hidden="true">
      <g stroke="currentColor" strokeWidth="1.4" opacity="0.45">
        <line x1="16" y1="16" x2="16" y2="5" />
        <line x1="16" y1="16" x2="26" y2="11" />
        <line x1="16" y1="16" x2="25" y2="23" />
        <line x1="16" y1="16" x2="7" y2="23" />
        <line x1="16" y1="16" x2="6" y2="11" />
      </g>
      <g fill="currentColor">
        <circle cx="16" cy="5" r="2.4" />
        <circle cx="26" cy="11" r="2.4" />
        <circle cx="25" cy="23" r="2.4" />
        <circle cx="7" cy="23" r="2.4" />
        <circle cx="6" cy="11" r="2.4" />
      </g>
      <g stroke="currentColor" strokeWidth="2.3" strokeLinecap="round">
        <line x1="16" y1="10" x2="16" y2="22" />
        <line x1="10.8" y1="13" x2="21.2" y2="19" />
        <line x1="21.2" y1="13" x2="10.8" y2="19" />
      </g>
    </svg>
  ),
};
