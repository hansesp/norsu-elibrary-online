update public.profiles
   set user_role = 'staff', status = 'approved', reviewed_at = now()
 where email = 'hansespanol00@gmail.com@';
