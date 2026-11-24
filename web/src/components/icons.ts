/*
 * Material Icons, Two-Tone style (Apache-2.0, @material-design-icons/svg).
 * Bundled locally as React components via vite-plugin-svgr; no icon font or
 * CDN. The app icon (graphic_eq) is also kept as an SVG file in
 * src/assets/icons/graphic_eq.svg. Map of Supabase/Lucide icon → Material
 * name is documented in Design.md.
 */
import { createIcon } from './icon'

import HomeIconSvg from '@material-design-icons/svg/two-tone/home.svg?react'
import TableEditorIconSvg from '@material-design-icons/svg/two-tone/table_chart.svg?react'
import SqlEditorIconSvg from '@material-design-icons/svg/two-tone/terminal.svg?react'
import DatabaseIconSvg from '@material-design-icons/svg/two-tone/storage.svg?react'
import AuthIconSvg from '@material-design-icons/svg/two-tone/group.svg?react'
import StorageIconSvg from '@material-design-icons/svg/two-tone/inventory_2.svg?react'
import EdgeFunctionsIconSvg from '@material-design-icons/svg/two-tone/functions.svg?react'
import RealtimeIconSvg from '@material-design-icons/svg/two-tone/sensors.svg?react'
import AdvisorsIconSvg from '@material-design-icons/svg/two-tone/lightbulb.svg?react'
import ObservabilityIconSvg from '@material-design-icons/svg/two-tone/insights.svg?react'
import LogsIconSvg from '@material-design-icons/svg/two-tone/receipt_long.svg?react'
import IntegrationsIconSvg from '@material-design-icons/svg/two-tone/extension.svg?react'
import SettingsIconSvg from '@material-design-icons/svg/two-tone/settings.svg?react'
import ProjectsIconSvg from '@material-design-icons/svg/two-tone/widgets.svg?react'
import TeamIconSvg from '@material-design-icons/svg/two-tone/groups.svg?react'
import UsageIconSvg from '@material-design-icons/svg/two-tone/data_usage.svg?react'
import SidebarIconSvg from '@material-design-icons/svg/two-tone/view_sidebar.svg?react'
import SearchIconSvg from '@material-design-icons/svg/two-tone/search.svg?react'
import HelpIconSvg from '@material-design-icons/svg/two-tone/help_outline.svg?react'
import AccountIconSvg from '@material-design-icons/svg/two-tone/account_circle.svg?react'
import PersonIconSvg from '@material-design-icons/svg/two-tone/person.svg?react'
import ChevronsUpDownIconSvg from '@material-design-icons/svg/two-tone/unfold_more.svg?react'
import ChevronDownIconSvg from '@material-design-icons/svg/two-tone/expand_more.svg?react'
import ChevronRightIconSvg from '@material-design-icons/svg/two-tone/chevron_right.svg?react'
import ChevronLeftIconSvg from '@material-design-icons/svg/two-tone/chevron_left.svg?react'
import CloseIconSvg from '@material-design-icons/svg/two-tone/close.svg?react'
import CheckIconSvg from '@material-design-icons/svg/two-tone/check.svg?react'
import DotIconSvg from '@material-design-icons/svg/two-tone/circle.svg?react'
import DarkModeIconSvg from '@material-design-icons/svg/two-tone/dark_mode.svg?react'
import LightModeIconSvg from '@material-design-icons/svg/two-tone/light_mode.svg?react'
import SystemThemeIconSvg from '@material-design-icons/svg/two-tone/desktop_windows.svg?react'
import LogoutIconSvg from '@material-design-icons/svg/two-tone/logout.svg?react'
import AddIconSvg from '@material-design-icons/svg/two-tone/add.svg?react'
import PaletteIconSvg from '@material-design-icons/svg/two-tone/palette.svg?react'
import CommandKeyIconSvg from '@material-design-icons/svg/two-tone/keyboard_command_key.svg?react'
import CopyIconSvg from '@material-design-icons/svg/two-tone/content_copy.svg?react'
import ExternalLinkIconSvg from '@material-design-icons/svg/two-tone/open_in_new.svg?react'
import InfoIconSvg from '@material-design-icons/svg/two-tone/info.svg?react'
import WarningIconSvg from '@material-design-icons/svg/two-tone/warning.svg?react'
import ErrorIconSvg from '@material-design-icons/svg/two-tone/error.svg?react'
import ConstructionIconSvg from '@material-design-icons/svg/two-tone/construction.svg?react'
import ApiIconSvg from '@material-design-icons/svg/two-tone/api.svg?react'
import ArticleIconSvg from '@material-design-icons/svg/two-tone/article.svg?react'
import TuneIconSvg from '@material-design-icons/svg/two-tone/tune.svg?react'
import ManageAccountsIconSvg from '@material-design-icons/svg/two-tone/manage_accounts.svg?react'
import AppIconSvg from '@/assets/icons/graphic_eq.svg?react'
import PlayIconSvg from '@material-design-icons/svg/two-tone/play_arrow.svg?react'
import StarIconSvg from '@material-design-icons/svg/two-tone/star.svg?react'
import StarBorderIconSvg from '@material-design-icons/svg/two-tone/star_border.svg?react'
import MoreIconSvg from '@material-design-icons/svg/two-tone/more_horiz.svg?react'
import MoreVertIconSvg from '@material-design-icons/svg/two-tone/more_vert.svg?react'
import SnippetIconSvg from '@material-design-icons/svg/two-tone/description.svg?react'
import FolderIconSvg from '@material-design-icons/svg/two-tone/folder.svg?react'
import FolderOpenIconSvg from '@material-design-icons/svg/two-tone/folder_open.svg?react'
import FileIconSvg from '@material-design-icons/svg/two-tone/insert_drive_file.svg?react'
import ImageIconSvg from '@material-design-icons/svg/two-tone/image.svg?react'
import LockIconSvg from '@material-design-icons/svg/two-tone/lock.svg?react'
import VerifiedUserIconSvg from '@material-design-icons/svg/two-tone/verified_user.svg?react'
import LockOpenIconSvg from '@material-design-icons/svg/two-tone/lock_open.svg?react'
import PublicIconSvg from '@material-design-icons/svg/two-tone/public.svg?react'
import KeyIconSvg from '@material-design-icons/svg/two-tone/key.svg?react'
import CodeIconSvg from '@material-design-icons/svg/two-tone/code.svg?react'
import TableViewIconSvg from '@material-design-icons/svg/two-tone/table_view.svg?react'
import RefreshIconSvg from '@material-design-icons/svg/two-tone/refresh.svg?react'
import DownloadIconSvg from '@material-design-icons/svg/two-tone/download.svg?react'
import UploadIconSvg from '@material-design-icons/svg/two-tone/upload.svg?react'
import DeleteIconSvg from '@material-design-icons/svg/two-tone/delete.svg?react'
import EditIconSvg from '@material-design-icons/svg/two-tone/edit.svg?react'
import FilterIconSvg from '@material-design-icons/svg/two-tone/filter_list.svg?react'
import SortIconSvg from '@material-design-icons/svg/two-tone/sort.svg?react'
import ColumnsIconSvg from '@material-design-icons/svg/two-tone/view_column.svg?react'
import PersonAddIconSvg from '@material-design-icons/svg/two-tone/person_add.svg?react'
import BlockIconSvg from '@material-design-icons/svg/two-tone/block.svg?react'
import MailIconSvg from '@material-design-icons/svg/two-tone/mail.svg?react'
import HistoryIconSvg from '@material-design-icons/svg/two-tone/history.svg?react'
import SchemaIconSvg from '@material-design-icons/svg/two-tone/schema.svg?react'
import BoltIconSvg from '@material-design-icons/svg/two-tone/bolt.svg?react'
import ListIconSvg from '@material-design-icons/svg/two-tone/list.svg?react'
import ArrowBackIconSvg from '@material-design-icons/svg/two-tone/arrow_back.svg?react'
import ArrowUpIconSvg from '@material-design-icons/svg/two-tone/arrow_upward.svg?react'
import ArrowDownIconSvg from '@material-design-icons/svg/two-tone/arrow_downward.svg?react'
import LinkIconSvg from '@material-design-icons/svg/two-tone/link.svg?react'
import CableIconSvg from '@material-design-icons/svg/two-tone/cable.svg?react'
import SaveIconSvg from '@material-design-icons/svg/two-tone/save.svg?react'
import VisibilityIconSvg from '@material-design-icons/svg/two-tone/visibility.svg?react'

/** Project overview (`home`) */
export const HomeIcon = createIcon(HomeIconSvg, 'home')
/** Table Editor (`table_chart`) */
export const TableEditorIcon = createIcon(TableEditorIconSvg, 'table_chart')
/** SQL Editor (`terminal`) */
export const SqlEditorIcon = createIcon(SqlEditorIconSvg, 'terminal')
/** Database (`storage`) */
export const DatabaseIcon = createIcon(DatabaseIconSvg, 'storage')
/** Authentication (`group`) */
export const AuthIcon = createIcon(AuthIconSvg, 'group')
/** Storage (`inventory_2`) */
export const StorageIcon = createIcon(StorageIconSvg, 'inventory_2')
/** Edge Functions (`functions`) */
export const EdgeFunctionsIcon = createIcon(EdgeFunctionsIconSvg, 'functions')
/** Realtime (`sensors`) */
export const RealtimeIcon = createIcon(RealtimeIconSvg, 'sensors')
/** Advisors (`lightbulb`) */
export const AdvisorsIcon = createIcon(AdvisorsIconSvg, 'lightbulb')
/** Observability (`insights`) */
export const ObservabilityIcon = createIcon(ObservabilityIconSvg, 'insights')
/** Logs (`receipt_long`) */
export const LogsIcon = createIcon(LogsIconSvg, 'receipt_long')
/** Integrations (`extension`) */
export const IntegrationsIcon = createIcon(IntegrationsIconSvg, 'extension')
/** Settings (`settings`) */
export const SettingsIcon = createIcon(SettingsIconSvg, 'settings')
/** Organization projects (`widgets`) */
export const ProjectsIcon = createIcon(ProjectsIconSvg, 'widgets')
/** Team (`groups`) */
export const TeamIcon = createIcon(TeamIconSvg, 'groups')
/** Usage (`data_usage`) */
export const UsageIcon = createIcon(UsageIconSvg, 'data_usage')
/** Sidebar control (`view_sidebar`) */
export const SidebarIcon = createIcon(SidebarIconSvg, 'view_sidebar')
/** Search (`search`) */
export const SearchIcon = createIcon(SearchIconSvg, 'search')
/** Help (`help_outline`) */
export const HelpIcon = createIcon(HelpIconSvg, 'help_outline')
/** Account (`account_circle`) */
export const AccountIcon = createIcon(AccountIconSvg, 'account_circle')
/** User (`person`) */
export const PersonIcon = createIcon(PersonIconSvg, 'person')
/** Switcher trigger (`unfold_more`) */
export const ChevronsUpDownIcon = createIcon(ChevronsUpDownIconSvg, 'unfold_more')
/** Select trigger (`expand_more`) */
export const ChevronDownIcon = createIcon(ChevronDownIconSvg, 'expand_more')
/** Submenu (`chevron_right`) */
export const ChevronRightIcon = createIcon(ChevronRightIconSvg, 'chevron_right')
/** Back (`chevron_left`) */
export const ChevronLeftIcon = createIcon(ChevronLeftIconSvg, 'chevron_left')
/** Close (`close`) */
export const CloseIcon = createIcon(CloseIconSvg, 'close')
/** Selected (`check`) */
export const CheckIcon = createIcon(CheckIconSvg, 'check')
/** Radio indicator (`circle`) */
export const DotIcon = createIcon(DotIconSvg, 'circle')
/** Dark theme (`dark_mode`) */
export const DarkModeIcon = createIcon(DarkModeIconSvg, 'dark_mode')
/** Light theme (`light_mode`) */
export const LightModeIcon = createIcon(LightModeIconSvg, 'light_mode')
/** System theme (`desktop_windows`) */
export const SystemThemeIcon = createIcon(SystemThemeIconSvg, 'desktop_windows')
/** Sign out (`logout`) */
export const LogoutIcon = createIcon(LogoutIconSvg, 'logout')
/** Create (`add`) */
export const AddIcon = createIcon(AddIconSvg, 'add')
/** Design system (`palette`) */
export const PaletteIcon = createIcon(PaletteIconSvg, 'palette')
/** Keyboard shortcut (`keyboard_command_key`) */
export const CommandKeyIcon = createIcon(CommandKeyIconSvg, 'keyboard_command_key')
/** Copy (`content_copy`) */
export const CopyIcon = createIcon(CopyIconSvg, 'content_copy')
/** External link (`open_in_new`) */
export const ExternalLinkIcon = createIcon(ExternalLinkIconSvg, 'open_in_new')
/** Info (`info`) */
export const InfoIcon = createIcon(InfoIconSvg, 'info')
/** Warning (`warning`) */
export const WarningIcon = createIcon(WarningIconSvg, 'warning')
/** Error (`error`) */
export const ErrorIcon = createIcon(ErrorIconSvg, 'error')
/** Coming soon (`construction`) */
export const ConstructionIcon = createIcon(ConstructionIconSvg, 'construction')
/** API (`api`) */
export const ApiIcon = createIcon(ApiIconSvg, 'api')
/** Docs (`article`) */
export const ArticleIcon = createIcon(ArticleIconSvg, 'article')
/** Preferences (`tune`) */
export const TuneIcon = createIcon(TuneIconSvg, 'tune')
/** Users admin (`manage_accounts`) */
export const ManageAccountsIcon = createIcon(ManageAccountsIconSvg, 'manage_accounts')
/** Supermixer app icon (`graphic_eq`) */
export const AppIcon = createIcon(AppIconSvg, 'graphic_eq')

// Stage 2: SQL, tables, auth users, storage
export const PlayIcon = createIcon(PlayIconSvg, 'play_arrow')
export const StarIcon = createIcon(StarIconSvg, 'star')
export const StarBorderIcon = createIcon(StarBorderIconSvg, 'star_border')
export const MoreIcon = createIcon(MoreIconSvg, 'more_horiz')
export const MoreVertIcon = createIcon(MoreVertIconSvg, 'more_vert')
export const SnippetIcon = createIcon(SnippetIconSvg, 'description')
export const FolderIcon = createIcon(FolderIconSvg, 'folder')
export const FolderOpenIcon = createIcon(FolderOpenIconSvg, 'folder_open')
export const FileIcon = createIcon(FileIconSvg, 'insert_drive_file')
export const ImageIcon = createIcon(ImageIconSvg, 'image')
export const LockIcon = createIcon(LockIconSvg, 'lock')
/** Two-factor sign-in, account security (`verified_user`) */
export const VerifiedUserIcon = createIcon(VerifiedUserIconSvg, 'verified_user')
export const LockOpenIcon = createIcon(LockOpenIconSvg, 'lock_open')
export const PublicIcon = createIcon(PublicIconSvg, 'public')
export const KeyIcon = createIcon(KeyIconSvg, 'key')
export const CodeIcon = createIcon(CodeIconSvg, 'code')
export const TableViewIcon = createIcon(TableViewIconSvg, 'table_view')
export const RefreshIcon = createIcon(RefreshIconSvg, 'refresh')
export const DownloadIcon = createIcon(DownloadIconSvg, 'download')
export const UploadIcon = createIcon(UploadIconSvg, 'upload')
export const DeleteIcon = createIcon(DeleteIconSvg, 'delete')
export const EditIcon = createIcon(EditIconSvg, 'edit')
export const FilterIcon = createIcon(FilterIconSvg, 'filter_list')
export const SortIcon = createIcon(SortIconSvg, 'sort')
export const ColumnsIcon = createIcon(ColumnsIconSvg, 'view_column')
export const PersonAddIcon = createIcon(PersonAddIconSvg, 'person_add')
export const BlockIcon = createIcon(BlockIconSvg, 'block')
export const MailIcon = createIcon(MailIconSvg, 'mail')
export const HistoryIcon = createIcon(HistoryIconSvg, 'history')
export const SchemaIcon = createIcon(SchemaIconSvg, 'schema')
export const BoltIcon = createIcon(BoltIconSvg, 'bolt')
export const ListIcon = createIcon(ListIconSvg, 'list')
export const ArrowBackIcon = createIcon(ArrowBackIconSvg, 'arrow_back')
export const ArrowUpIcon = createIcon(ArrowUpIconSvg, 'arrow_upward')
export const ArrowDownIcon = createIcon(ArrowDownIconSvg, 'arrow_downward')
export const LinkIcon = createIcon(LinkIconSvg, 'link')
export const CableIcon = createIcon(CableIconSvg, 'cable')
export const SaveIcon = createIcon(SaveIconSvg, 'save')
export const VisibilityIcon = createIcon(VisibilityIconSvg, 'visibility')
