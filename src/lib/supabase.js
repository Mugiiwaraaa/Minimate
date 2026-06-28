import { createClient } from '@supabase/supabase-js'

var supabaseUrl = import.meta.env.VITE_SUPABASE_URL || ''
var supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || ''

export var isDemo = !supabaseUrl || supabaseUrl === 'https://your-project.supabase.co' || supabaseUrl === ''
export var supabase = isDemo ? null : createClient(supabaseUrl, supabaseAnonKey)
