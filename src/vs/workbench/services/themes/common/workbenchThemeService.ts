/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { refineServiceDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { Event } from '../../../../base/common/event.js';
import { Color } from '../../../../base/common/color.js';
import { IColorTheme, IThemeService, IFileIconTheme, IProductIconTheme } from '../../../../platform/theme/common/themeService.js';
import { ConfigurationTarget } from '../../../../platform/configuration/common/configuration.js';
import { isBoolean, isString } from '../../../../base/common/types.js';
import { IconContribution, IconDefinition } from '../../../../platform/theme/common/iconRegistry.js';
import { ColorScheme, ThemeTypeSelector } from '../../../../platform/theme/common/theme.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';

export const IWorkbenchThemeService = refineServiceDecorator<IThemeService, IWorkbenchThemeService>(IThemeService);

export const THEME_SCOPE_OPEN_PAREN = '[';
export const THEME_SCOPE_CLOSE_PAREN = ']';
export const THEME_SCOPE_WILDCARD = '*';

export const themeScopeRegex = /\[(.+?)\]/g;

export enum ThemeSettings {
	COLOR_THEME = 'workbench.colorTheme',
	FILE_ICON_THEME = 'workbench.iconTheme',
	PRODUCT_ICON_THEME = 'workbench.productIconTheme',
	COLOR_CUSTOMIZATIONS = 'workbench.colorCustomizations',
	TOKEN_COLOR_CUSTOMIZATIONS = 'editor.tokenColorCustomizations',
	SEMANTIC_TOKEN_COLOR_CUSTOMIZATIONS = 'editor.semanticTokenColorCustomizations',

	PREFERRED_DARK_THEME = 'workbench.preferredDarkColorTheme',
	PREFERRED_LIGHT_THEME = 'workbench.preferredLightColorTheme',
	PREFERRED_HC_DARK_THEME = 'workbench.preferredHighContrastColorTheme', /* id kept for compatibility reasons */
	PREFERRED_HC_LIGHT_THEME = 'workbench.preferredHighContrastLightColorTheme',
	DETECT_COLOR_SCHEME = 'window.autoDetectColorScheme',
	DETECT_HC = 'window.autoDetectHighContrast',

	SYSTEM_COLOR_THEME = 'window.systemColorTheme'
}

export namespace ThemeSettingDefaults {
	export const COLOR_THEME_DARK = 'Klawly Dark';
	export const COLOR_THEME_LIGHT = 'Klawly Light';
	export const COLOR_THEME_HC_DARK = 'Default High Contrast';
	export const COLOR_THEME_HC_LIGHT = 'Default High Contrast Light';

	export const FILE_ICON_THEME = 'vs-seti';
	export const PRODUCT_ICON_THEME = 'Default';
}

/**
 * Migrates legacy theme settings IDs to their current equivalents.
 * Theme IDs were simplified: "Default" prefix was removed from built-in themes,
 * and "Experimental" prefix was replaced when VS Code themes became GA.
 */
export function migrateThemeSettingsId(settingsId: string): string {
	switch (settingsId) {
		case 'Default Dark Modern': return 'Dark Modern';
		case 'Default Light Modern': return 'Light Modern';
		case 'Default Dark+': return 'Dark+';
		case 'Default Light+': return 'Light+';
		case 'Experimental Dark':
		case 'VS Code Dark':
			return ThemeSettingDefaults.COLOR_THEME_DARK;
		case 'Experimental Light':
		case 'VS Code Light':
			return ThemeSettingDefaults.COLOR_THEME_LIGHT;
	}
	return settingsId;
}

export const COLOR_THEME_DARK_INITIAL_COLORS = {
	'actionBar.toggledBackground': '#383a49',
	'activityBar.activeBorder': '#bdbdbd',
	'activityBar.background': '#131313',
	'activityBar.border': '#00000000',
	'activityBar.foreground': '#e8e8e8',
	'activityBar.inactiveForeground': '#a0a0a0',
	'activityBarBadge.background': '#bdbdbd',
	'activityBarBadge.foreground': '#141414',
	'badge.background': '#e8e8e814',
	'badge.foreground': '#bdbdbd',
	'button.background': '#dd8f52',
	'button.border': '#00000000',
	'button.foreground': '#141414',
	'button.hoverBackground': '#c5804b',
	'button.secondaryBackground': '#ffffff14',
	'button.secondaryForeground': '#e8e8e8',
	'button.secondaryHoverBackground': '#ffffff24',
	'chat.slashCommandBackground': '#26477866',
	'chat.slashCommandForeground': '#85B6FF',
	'chat.editedFileForeground': '#E2C08D',
	'checkbox.background': '#ffffff0f',
	'checkbox.border': '#808080',
	'debugToolBar.background': '#181818',
	'descriptionForeground': '#a0a0a0',
	'dropdown.background': '#2c2c2c',
	'dropdown.border': '#808080',
	'dropdown.foreground': '#e8e8e8',
	'dropdown.listBackground': '#353535',
	'editor.background': '#242424',
	'editor.findMatchBackground': '#e6c35c66',
	'editor.foreground': '#e8e8e8',
	'editor.inactiveSelectionBackground': '#93a0f026',
	'editor.selectionHighlightBackground': '#93a0f01f',
	'editorGroup.border': '#ffffff14',
	'editorGroupHeader.tabsBackground': '#1b1b1b',
	'editorGroupHeader.tabsBorder': '#00000000',
	'editorGutter.addedBackground': '#4cae7a',
	'editorGutter.deletedBackground': '#e5566e',
	'editorGutter.modifiedBackground': '#7aaae6',
	'editorIndentGuide.activeBackground1': '#ffffff30',
	'editorIndentGuide.background1': '#ffffff12',
	'editorLineNumber.activeForeground': '#bdbdbd',
	'editorLineNumber.foreground': '#6e6e6e',
	'editorOverviewRuler.border': '#00000000',
	'editorWidget.background': '#353535',
	'errorForeground': '#f27b8f',
	'focusBorder': '#93a0f0',
	'foreground': '#bdbdbd',
	'icon.foreground': '#a3a3a3',
	'input.background': '#2c2c2c',
	'input.border': '#808080',
	'input.foreground': '#e8e8e8',
	'input.placeholderForeground': '#6e6e6e',
	'inputOption.activeBackground': '#93a0f03d',
	'inputOption.activeBorder': '#93a0f099',
	'keybindingLabel.foreground': '#cfcfcf',
	'list.activeSelectionIconForeground': '#e8e8e8',
	'list.dropBackground': '#93a0f01a',
	'menu.background': '#353535',
	'menu.border': '#ffffff14',
	'menu.foreground': '#d6d6d6',
	'menu.selectionBackground': '#e8e8e81f',
	'menu.separatorBackground': '#ffffff14',
	'notificationCenterHeader.background': '#353535',
	'notificationCenterHeader.foreground': '#CCCCCC',
	'notifications.background': '#353535',
	'notifications.border': '#ffffff14',
	'notifications.foreground': '#CCCCCC',
	'panel.background': '#1b1b1b',
	'panel.border': '#ffffff14',
	'panelInput.border': '#2B2B2B',
	'panelTitle.activeBorder': '#bdbdbd',
	'panelTitle.activeForeground': '#e8e8e8',
	'panelTitle.inactiveForeground': '#a0a0a0',
	'peekViewEditor.background': '#242424',
	'peekViewEditor.matchHighlightBackground': '#e6c35c33',
	'peekViewResult.background': '#2c2c2c',
	'peekViewResult.matchHighlightBackground': '#e6c35c33',
	'pickerGroup.border': '#ffffff14',
	'ports.iconRunningProcessForeground': '#369432',
	'progressBar.background': '#dd8f52',
	'quickInput.background': '#353535',
	'quickInput.foreground': '#d6d6d6',
	'settings.dropdownBackground': '#313131',
	'settings.dropdownBorder': '#3C3C3C',
	'settings.headerForeground': '#e8e8e8',
	'settings.modifiedItemIndicator': '#7aaae6',
	'sideBar.background': '#1b1b1b',
	'sideBar.border': '#ffffff14',
	'sideBar.foreground': '#bdbdbd',
	'sideBarSectionHeader.background': '#1b1b1b',
	'sideBarSectionHeader.border': '#ffffff14',
	'sideBarSectionHeader.foreground': '#bdbdbd',
	'sideBarTitle.foreground': '#bdbdbd',
	'statusBar.background': '#131313',
	'statusBar.border': '#00000000',
	'statusBar.debuggingBackground': '#93a0f0',
	'statusBar.debuggingForeground': '#141414',
	'statusBar.focusBorder': '#0078D4',
	'statusBar.foreground': '#bdbdbd',
	'statusBar.noFolderBackground': '#131313',
	'statusBarItem.focusBorder': '#0078D4',
	'statusBarItem.prominentBackground': '#e8e8e81a',
	'statusBarItem.remoteBackground': '#e8e8e80f',
	'statusBarItem.remoteForeground': '#e8e8e8',
	'tab.activeBackground': '#242424',
	'tab.activeBorder': '#242424',
	'tab.activeBorderTop': '#bdbdbd',
	'tab.activeForeground': '#e8e8e8',
	'tab.border': '#00000000',
	'tab.hoverBackground': '#202020',
	'tab.inactiveBackground': '#1b1b1b',
	'tab.inactiveForeground': '#a0a0a0',
	'tab.lastPinnedBorder': '#ccc3',
	'tab.selectedBackground': '#37373D',
	'tab.selectedBorderTop': '#6caddf',
	'tab.selectedForeground': '#FFFFFF',
	'tab.unfocusedActiveBorder': '#1F1F1F',
	'tab.unfocusedActiveBorderTop': '#6e6e6e',
	'tab.unfocusedHoverBackground': '#1F1F1F',
	'terminal.foreground': '#d6d6d6',
	'terminal.inactiveSelectionBackground': '#3A3D41',
	'terminal.tab.activeBorder': '#0078D4',
	'textBlockQuote.background': '#2c2c2c',
	'textBlockQuote.border': '#ffffff14',
	'textCodeBlock.background': '#ffffff0d',
	'textLink.activeForeground': '#b3bcf5',
	'textLink.foreground': '#93a0f0',
	'textPreformat.background': '#ffffff12',
	'textPreformat.foreground': '#d6d6d6',
	'textSeparator.foreground': '#ffffff14',
	'titleBar.activeBackground': '#131313',
	'titleBar.activeForeground': '#bdbdbd',
	'titleBar.border': '#00000000',
	'titleBar.inactiveBackground': '#131313',
	'titleBar.inactiveForeground': '#6e6e6e',
	'welcomePage.progress.foreground': '#0078D4',
	'welcomePage.tileBackground': '#2B2B2B',
	'widget.border': '#313131'
};

export const COLOR_THEME_LIGHT_INITIAL_COLORS = {
	'actionBar.toggledBackground': '#dddddd',
	'activityBar.activeBorder': '#4d4d4d',
	'activityBar.background': '#ebebeb',
	'activityBar.border': '#00000000',
	'activityBar.foreground': '#1d1d1d',
	'activityBar.inactiveForeground': '#666666',
	'activityBarBadge.background': '#4d4d4d',
	'activityBarBadge.foreground': '#ffffff',
	'badge.background': '#1d1d1d14',
	'badge.foreground': '#4d4d4d',
	'button.background': '#dd8f52',
	'button.border': '#00000000',
	'button.foreground': '#141414',
	'button.hoverBackground': '#c5804b',
	'button.secondaryBackground': '#1d1d1d12',
	'button.secondaryForeground': '#1d1d1d',
	'button.secondaryHoverBackground': '#1d1d1d1f',
	'chat.slashCommandBackground': '#ADCEFF7A',
	'chat.slashCommandForeground': '#26569E',
	'chat.editedFileForeground': '#895503',
	'checkbox.background': '#ffffff',
	'checkbox.border': '#8a8a8a',
	'descriptionForeground': '#666666',
	'diffEditor.unchangedRegionBackground': '#f2f2f2',
	'dropdown.background': '#ffffff',
	'dropdown.border': '#8a8a8a',
	'dropdown.foreground': '#1d1d1d',
	'dropdown.listBackground': '#ffffff',
	'editor.background': '#fcfcfc',
	'editor.foreground': '#1d1d1d',
	'editor.inactiveSelectionBackground': '#4d5bc91a',
	'editor.selectionHighlightBackground': '#4d5bc914',
	'editorGroup.border': '#1d1d1d14',
	'editorGroupHeader.tabsBackground': '#f3f3f3',
	'editorGroupHeader.tabsBorder': '#00000000',
	'editorGutter.addedBackground': '#1a7f4e',
	'editorGutter.deletedBackground': '#c23652',
	'editorGutter.modifiedBackground': '#2d65ad',
	'editorIndentGuide.activeBackground1': '#1d1d1d30',
	'editorIndentGuide.background1': '#1d1d1d12',
	'editorLineNumber.activeForeground': '#4d4d4d',
	'editorLineNumber.foreground': '#a3a3a3',
	'editorOverviewRuler.border': '#00000000',
	'editorSuggestWidget.background': '#ffffff',
	'editorWidget.background': '#ffffff',
	'errorForeground': '#bb344b',
	'focusBorder': '#4d5bc9',
	'foreground': '#4d4d4d',
	'icon.foreground': '#5f5f5f',
	'input.background': '#ffffff',
	'input.border': '#8a8a8a',
	'input.foreground': '#1d1d1d',
	'input.placeholderForeground': '#a3a3a3',
	'inputOption.activeBackground': '#4d5bc93d',
	'inputOption.activeBorder': '#4d5bc999',
	'inputOption.activeForeground': '#1d1d1d',
	'keybindingLabel.foreground': '#555555',
	'list.activeSelectionBackground': '#1d1d1d1a',
	'list.activeSelectionForeground': '#1d1d1d',
	'list.activeSelectionIconForeground': '#1d1d1d',
	'list.focusAndSelectionOutline': '#4d5bc9',
	'list.hoverBackground': '#1d1d1d0d',
	'menu.border': '#1d1d1d14',
	'menu.selectionBackground': '#1d1d1d1a',
	'menu.selectionForeground': '#1d1d1d',
	'notebook.cellBorderColor': '#E5E5E5',
	'notebook.selectedCellBackground': '#C8DDF150',
	'notificationCenterHeader.background': '#ffffff',
	'notificationCenterHeader.foreground': '#3B3B3B',
	'notifications.background': '#ffffff',
	'notifications.border': '#1d1d1d14',
	'notifications.foreground': '#3B3B3B',
	'panel.background': '#f3f3f3',
	'panel.border': '#1d1d1d14',
	'panelInput.border': '#E5E5E5',
	'panelTitle.activeBorder': '#4d4d4d',
	'panelTitle.activeForeground': '#1d1d1d',
	'panelTitle.inactiveForeground': '#666666',
	'peekViewEditor.matchHighlightBackground': '#e6c35c40',
	'peekViewResult.background': '#f7f7f7',
	'peekViewResult.matchHighlightBackground': '#e6c35c40',
	'pickerGroup.border': '#1d1d1d14',
	'pickerGroup.foreground': '#666666',
	'ports.iconRunningProcessForeground': '#369432',
	'progressBar.background': '#dd8f52',
	'quickInput.background': '#ffffff',
	'quickInput.foreground': '#2a2a2a',
	'searchEditor.textInputBorder': '#CECECE',
	'settings.dropdownBackground': '#FFFFFF',
	'settings.dropdownBorder': '#CECECE',
	'settings.headerForeground': '#1d1d1d',
	'settings.modifiedItemIndicator': '#2d65ad',
	'settings.numberInputBorder': '#CECECE',
	'settings.textInputBorder': '#CECECE',
	'sideBar.background': '#f3f3f3',
	'sideBar.border': '#1d1d1d14',
	'sideBar.foreground': '#4d4d4d',
	'sideBarSectionHeader.background': '#f3f3f3',
	'sideBarSectionHeader.border': '#1d1d1d14',
	'sideBarSectionHeader.foreground': '#4d4d4d',
	'sideBarTitle.foreground': '#4d4d4d',
	'statusBar.background': '#ebebeb',
	'statusBar.border': '#00000000',
	'statusBar.debuggingBackground': '#4d5bc9',
	'statusBar.debuggingForeground': '#ffffff',
	'statusBar.focusBorder': '#005FB8',
	'statusBar.foreground': '#4d4d4d',
	'statusBar.noFolderBackground': '#ebebeb',
	'statusBarItem.compactHoverBackground': '#CCCCCC',
	'statusBarItem.errorBackground': '#C72E0F',
	'statusBarItem.focusBorder': '#005FB8',
	'statusBarItem.hoverBackground': '#1d1d1d0d',
	'statusBarItem.prominentBackground': '#1d1d1d14',
	'statusBarItem.remoteBackground': '#1d1d1d0d',
	'statusBarItem.remoteForeground': '#1d1d1d',
	'tab.activeBackground': '#fcfcfc',
	'tab.activeBorder': '#fcfcfc',
	'tab.activeBorderTop': '#4d4d4d',
	'tab.activeForeground': '#1d1d1d',
	'tab.border': '#00000000',
	'tab.hoverBackground': '#f7f7f7',
	'tab.inactiveBackground': '#f3f3f3',
	'tab.inactiveForeground': '#666666',
	'tab.lastPinnedBorder': '#D4D4D4',
	'tab.selectedBackground': '#E4E6F1',
	'tab.selectedBorderTop': '#68a3da',
	'tab.selectedForeground': '#333333',
	'tab.unfocusedActiveBorder': '#F8F8F8',
	'tab.unfocusedActiveBorderTop': '#a3a3a3',
	'tab.unfocusedHoverBackground': '#F8F8F8',
	'terminal.foreground': '#2a2a2a',
	'terminal.inactiveSelectionBackground': '#E5EBF1',
	'terminal.tab.activeBorder': '#005FB8',
	'terminalCursor.foreground': '#4d5bc9',
	'textBlockQuote.background': '#f2f2f2',
	'textBlockQuote.border': '#1d1d1d14',
	'textCodeBlock.background': '#1d1d1d0a',
	'textLink.activeForeground': '#3d48a0',
	'textLink.foreground': '#4d5bc9',
	'textPreformat.background': '#1d1d1d0f',
	'textPreformat.foreground': '#2a2a2a',
	'textSeparator.foreground': '#1d1d1d14',
	'titleBar.activeBackground': '#ebebeb',
	'titleBar.activeForeground': '#4d4d4d',
	'titleBar.border': '#00000000',
	'titleBar.inactiveBackground': '#ebebeb',
	'titleBar.inactiveForeground': '#a3a3a3',
	'welcomePage.tileBackground': '#F3F3F3',
	'widget.border': '#E5E5E5'
};

export interface IWorkbenchTheme {
	readonly id: string;
	readonly label: string;
	readonly extensionData?: ExtensionData;
	readonly description?: string;
	readonly settingsId: string | null;
}

export interface IWorkbenchColorTheme extends IWorkbenchTheme, IColorTheme {
	readonly settingsId: string;
	readonly tokenColors: ITextMateThemingRule[];
}

export interface IColorMap {
	[id: string]: Color;
}

export interface IWorkbenchFileIconTheme extends IWorkbenchTheme, IFileIconTheme {
}

export interface IWorkbenchProductIconTheme extends IWorkbenchTheme, IProductIconTheme {
	readonly settingsId: string;

	getIcon(icon: IconContribution): IconDefinition | undefined;
}

export type ThemeSettingTarget = ConfigurationTarget | undefined | 'auto' | 'preview';


export interface IWorkbenchThemeService extends IThemeService {
	readonly _serviceBrand: undefined;
	setColorTheme(themeId: string | undefined | IWorkbenchColorTheme, settingsTarget: ThemeSettingTarget): Promise<IWorkbenchColorTheme | null>;
	getColorTheme(): IWorkbenchColorTheme;
	/** Returns the selected theme and user customizations without window-local overlays. */
	getBaseColorTheme(): IWorkbenchColorTheme;
	getColorThemes(): Promise<IWorkbenchColorTheme[]>;
	getMarketplaceColorThemes(publisher: string, name: string, version: string): Promise<IWorkbenchColorTheme[]>;
	readonly onDidColorThemeChange: Event<IWorkbenchColorTheme>;

	/** Applies window-local colors computed from the base theme, without persisting them or changing the selected theme. */
	registerColorThemeOverlay(getColors: (theme: IWorkbenchColorTheme) => IColorMap): IDisposable;

	getPreferredColorScheme(): ColorScheme | undefined;

	setFileIconTheme(iconThemeId: string | undefined | IWorkbenchFileIconTheme, settingsTarget: ThemeSettingTarget): Promise<IWorkbenchFileIconTheme>;
	getFileIconTheme(): IWorkbenchFileIconTheme;
	getFileIconThemes(): Promise<IWorkbenchFileIconTheme[]>;
	getMarketplaceFileIconThemes(publisher: string, name: string, version: string): Promise<IWorkbenchFileIconTheme[]>;
	readonly onDidFileIconThemeChange: Event<IWorkbenchFileIconTheme>;

	setProductIconTheme(iconThemeId: string | undefined | IWorkbenchProductIconTheme, settingsTarget: ThemeSettingTarget): Promise<IWorkbenchProductIconTheme>;
	getProductIconTheme(): IWorkbenchProductIconTheme;
	getProductIconThemes(): Promise<IWorkbenchProductIconTheme[]>;
	getMarketplaceProductIconThemes(publisher: string, name: string, version: string): Promise<IWorkbenchProductIconTheme[]>;
	readonly onDidProductIconThemeChange: Event<IWorkbenchProductIconTheme>;
}

export interface IThemeScopedColorCustomizations {
	[colorId: string]: string;
}

export interface IColorCustomizations {
	[colorIdOrThemeScope: string]: IThemeScopedColorCustomizations | string;
}

export interface IThemeScopedTokenColorCustomizations {
	[groupId: string]: ITextMateThemingRule[] | ITokenColorizationSetting | boolean | string | undefined;
	comments?: string | ITokenColorizationSetting;
	strings?: string | ITokenColorizationSetting;
	numbers?: string | ITokenColorizationSetting;
	keywords?: string | ITokenColorizationSetting;
	types?: string | ITokenColorizationSetting;
	functions?: string | ITokenColorizationSetting;
	variables?: string | ITokenColorizationSetting;
	textMateRules?: ITextMateThemingRule[];
	semanticHighlighting?: boolean; // deprecated, use ISemanticTokenColorCustomizations.enabled instead
}

export interface ITokenColorCustomizations {
	[groupIdOrThemeScope: string]: IThemeScopedTokenColorCustomizations | ITextMateThemingRule[] | ITokenColorizationSetting | boolean | string | undefined;
	comments?: string | ITokenColorizationSetting;
	strings?: string | ITokenColorizationSetting;
	numbers?: string | ITokenColorizationSetting;
	keywords?: string | ITokenColorizationSetting;
	types?: string | ITokenColorizationSetting;
	functions?: string | ITokenColorizationSetting;
	variables?: string | ITokenColorizationSetting;
	textMateRules?: ITextMateThemingRule[];
	semanticHighlighting?: boolean; // deprecated, use ISemanticTokenColorCustomizations.enabled instead
}

export interface IThemeScopedSemanticTokenColorCustomizations {
	[styleRule: string]: ISemanticTokenRules | boolean | undefined;
	enabled?: boolean;
	rules?: ISemanticTokenRules;
}

export interface ISemanticTokenColorCustomizations {
	[styleRuleOrThemeScope: string]: IThemeScopedSemanticTokenColorCustomizations | ISemanticTokenRules | boolean | undefined;
	enabled?: boolean;
	rules?: ISemanticTokenRules;
}

export interface IThemeScopedExperimentalSemanticTokenColorCustomizations {
	[themeScope: string]: ISemanticTokenRules | undefined;
}

export interface IExperimentalSemanticTokenColorCustomizations {
	[styleRuleOrThemeScope: string]: IThemeScopedExperimentalSemanticTokenColorCustomizations | ISemanticTokenRules | undefined;
}

export type IThemeScopedCustomizations =
	IThemeScopedColorCustomizations
	| IThemeScopedTokenColorCustomizations
	| IThemeScopedExperimentalSemanticTokenColorCustomizations
	| IThemeScopedSemanticTokenColorCustomizations;

export type IThemeScopableCustomizations =
	IColorCustomizations
	| ITokenColorCustomizations
	| IExperimentalSemanticTokenColorCustomizations
	| ISemanticTokenColorCustomizations;

export interface ISemanticTokenRules {
	[selector: string]: string | ISemanticTokenColorizationSetting | undefined;
}

export interface ITextMateThemingRule {
	name?: string;
	scope?: string | string[];
	settings: ITokenColorizationSetting;
}

export interface ITokenColorizationSetting {
	foreground?: string;
	background?: string;
	fontStyle?: string; /* [italic|bold|underline|strikethrough] */
	fontFamily?: string;
	fontSize?: number;
	lineHeight?: number;
}

export interface ISemanticTokenColorizationSetting {
	foreground?: string;
	fontStyle?: string; /* [italic|bold|underline|strikethrough] */
	bold?: boolean;
	underline?: boolean;
	strikethrough?: boolean;
	italic?: boolean;
}

export interface ExtensionData {
	extensionId: string;
	extensionPublisher: string;
	extensionName: string;
	extensionIsBuiltin: boolean;
}

export namespace ExtensionData {
	export function toJSONObject(d: ExtensionData | undefined): any {
		return d && { _extensionId: d.extensionId, _extensionIsBuiltin: d.extensionIsBuiltin, _extensionName: d.extensionName, _extensionPublisher: d.extensionPublisher };
	}
	export function fromJSONObject(o: any): ExtensionData | undefined {
		if (o && isString(o._extensionId) && isBoolean(o._extensionIsBuiltin) && isString(o._extensionName) && isString(o._extensionPublisher)) {
			return { extensionId: o._extensionId, extensionIsBuiltin: o._extensionIsBuiltin, extensionName: o._extensionName, extensionPublisher: o._extensionPublisher };
		}
		return undefined;
	}
	export function fromName(publisher: string, name: string, isBuiltin = false): ExtensionData {
		return { extensionPublisher: publisher, extensionId: `${publisher}.${name}`, extensionName: name, extensionIsBuiltin: isBuiltin };
	}
}

export interface IThemeExtensionPoint {
	id: string;
	label?: string;
	description?: string;
	path: string;
	uiTheme?: ThemeTypeSelector;
	_watch: boolean; // unsupported options to watch location
}
