/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Klawly mark silhouette path in a 96-unit box, written by build/klawly/generate-icons.ts
// from resources/klawly/klawly-mark-mono.svg (issue 751).
// The aquarium cannot use that SVG file directly because each fish renders the
// logo as live, same-document SVG geometry: fish.ts stores this path in a
// shared <symbol>, then renders clipped <use> slices with staggered CSS
// animations. That keeps the swimming-strip effect, currentColor species
// tinting, and auxiliary-window support while avoiding duplicate path parsing
// per fish.
export const VSCODE_LOGO_PATH = 'M21.675 9.37A9.019 9.019 0 0 1 30.694 18.389L30.694 77.377A9.019 9.019 0 0 1 21.675 86.395A9.019 9.019 0 0 1 12.656 77.377L12.656 18.389A9.019 9.019 0 0 1 21.675 9.37ZM27.281 37.889C50.438 36.67 67.5 28.139 81.15 7.42C76.031 37.889 55.313 57.389 27.281 58.608ZM28.5 52.27C65.063 51.295 81.15 67.87 83.344 88.589C74.325 76.158 58.969 70.795 28.5 70.795Z';